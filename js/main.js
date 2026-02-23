import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createCanvas, loadImage } from "canvas";
import { PQ } from './pq.js';
import * as AIS from './ais.js';

const IMPLEMENTATION_VERSION = 4;
const isDebug = process.env.DEBUG === 'true';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const isLive = process.env.LIVE;

const BatchConfig = {
  identifiersUrl: 'https://suikawiki.github.io/swcf/current/swir/list.json',
  timeoutMs: 10 * 60 * 1000, // 10 minutes
  progressIntervalMs: 15 * 1000, // 15 seconds
  errorThreshold: 10,
  sizeLimitBytes: isLive ? 1 * 1024 * 1024 * 1024 : 100 * 1024 * 1024,
  consecutive429Threshold: 10, // Increased threshold
  initialSleepMsOn429: 2000, // Start with 2 seconds
  maxSleepMsOn429: 30000, // Cap at 30 seconds
};

let Config = {
  image_proxy_url_prefix: "",
  sw_storage_url_prefix: 'https://wiki.suikawiki.org/n/',
};
let dataSource = new AIS.ImageDataSource(Config);
let annotationStorage = new AIS.ClassicAnnotationStorage(Config);


PQ.env.createCanvas = createCanvas;
PQ.env.createImg = async url => {
  let res = await fetch (url);
  if (res.status !== 200) throw res;
  let buffer = Buffer.from (await res.arrayBuffer ());
  let img = await loadImage (buffer);
  return img;
};

const __filename = fileURLToPath (import.meta.url);
const __dirname = path.dirname (__filename);
const indexesDir = path.join (__dirname, 'local', 'indexes');
const objectsDir = path.join (__dirname, 'local', 'objects');
const missingFile = path.join (indexesDir, 'missing.txt');

function getObjectPath (id) {
  const epRegex = /^:ep-(x[A-Za-z0-9]+-[A-Za-z0-9_-]+)-([0-9a-f]+)$/;
  const match = id.match (epRegex);

  if (match && match[1].length <= 100 && match[2].length <= 100) {
    const [, group1, group2] = match;
    return path.join (objectsDir, group1, `${group2}.jpeg`);
  } // if epRegex

  const hash = crypto.createHash ('sha1').update (id).digest ('hex');
  const dir = `sha-${hash.substring (0, 2)}`;
  const filename = `${hash.substring (2)}.jpeg`;
  return path.join (objectsDir, dir, filename);
} // getObjectPath

async function fetchListData () {
  console.error (`--> Fetching list data from ${BatchConfig.identifiersUrl}...`);
  const response = await fetch (BatchConfig.identifiersUrl);
  if (!response.ok) {
    throw new Error (`Failed to fetch list data: ${response.statusText}`);
  }
  const json = await response.json ();
  console.error (`--> Found ${Object.keys(json.items).length} items and ${Object.keys(json.groups).length} groups.`);
  return json;
} // fetchListData

function getDirectorySize (dirPath) {
  let totalSize = 0;
  try {
    const files = fs.readdirSync (dirPath, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      try {
        if (file.isDirectory ()) {
          totalSize += getDirectorySize (filePath);
        } else {
          const stats = fs.statSync (filePath);
          totalSize += stats.size;
        }
      } catch (e) {
        console.error (`--> Could not stat file ${filePath}: ${e.message}. Skipping.`);
      } // catch stat
    } // for
  } catch (e) {
    if (e.code === 'ENOENT') return 0; // not an error, just empty
    throw e;
  }
  return totalSize;
} // getDirectorySize

async function processSingleItem (id, item) {
  if (!item.tags?.free) {
    return { skipped: true, reason: 'Item not tagged as free.' };
  } // if not free

  let parsed = dataSource.parseImageInput (item);
  if (!parsed) {
    console.error (`--> Bad image input for ${id}. Skipping.`);
    console.error({item});
    return { skipped: true, reason: 'Bad image input.' };
  } // if not parsed

  let json;
  try {
    json = await annotationStorage.getAnnotationData ({ imageSource: parsed.imageSource });
  } catch (e) {
    if (e.status === 429) {
      console.warn(`--> Rate limited (429) while fetching annotation for ${id}.`);
      return { rateLimited: true };
    }
    console.error (`--> Error fetching annotation data for ${id}: Skipping.`);
    console.error({item, parsed, e});
    return { failed: true };
  }

  const annotationItem = json?.items?.find (_ => _.regionKey === parsed.imageRegion.regionKey);

  if (!annotationItem) {
    console.error (`--> Annotation item not found for ${id}. Skipping.`);
    console.error({item, parsed});
    return { skipped: true, reason: 'Annotation item not found.' };
  }

  const originalParsed = parsed;
  parsed = dataSource.parseImageInput ({
    image_source: json.image,
    image_region: { region_boundary: annotationItem.regionBoundary },
  });
  if (!parsed) {
    console.error (`--> Bad input after annotation for ${id}. Skipping.`);
    console.error({item, originalParsed, annotationItem });
    return { skipped: true, reason: 'Bad input after annotation.' };
  }
  
  try {
    const image = await dataSource.getClippedImageCanvas (parsed, { useCache: true });
    const imageSourceWithLegalModified = { ...parsed.imageSource, legalModified: true };
    const buffer = await PQ.Image.SerializeCanvas(image, imageSourceWithLegalModified, { type: 'image/jpeg' });
    const objectFile = getObjectPath (id);
    return { buffer, objectFile };
  } catch (e) {
    console.error (`--> Failed to generate image for ${id}: Skipping.`);
    console.error({item, parsed, annotationItem });
    console.error(e);
    return { failed: true };
  }
} // processSingleItem

async function processMirrorSet (mirrorSet, incomingItems) {
  console.error (`--> Processing mirror set ${mirrorSet}...`);
  const startTime = Date.now();

  const existingObjectsVersions = new Map();
  console.error ('--> Reading all existing index files to build a comprehensive list of objects and their versions...');
  try {
    const indexFiles = fs.readdirSync(indexesDir).filter(f => f.startsWith('list-') && f.endsWith('.txt')).sort();
    for (const file of indexFiles) {
      const filePath = path.join (indexesDir, file);
      const lines = fs.readFileSync (filePath, 'utf8').split('\n').filter (Boolean);
      for (const line of lines) {
        const [id, versionStr] = line.split('\t');
        const version = versionStr ? parseInt(versionStr, 10) : 0; // Default to version 0 for old format
        if (id) {
          existingObjectsVersions.set(id, version);
        }
      }
    }
    console.error (`--> Found ${existingObjectsVersions.size} existing objects from ${indexFiles.length} index file(s).`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error (`--> Error reading index directory: ${e.message}`);
    } else {
      console.error ('--> No index directory found. Starting fresh.');
    }
  }

  const missingIdentifiers = new Set();
  try {
    const lines = fs.readFileSync(missingFile, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      missingIdentifiers.add(line);
    }
    console.error(`--> Found ${missingIdentifiers.size} items that failed in the previous run. Retrying them.`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`--> Error reading missing identifiers file: ${e.message}`);
    } else {
      console.error('--> No previously failed items file found.');
    }
  }

  const currentIndexFile = path.join (indexesDir, `list-${mirrorSet}.txt`);

  let consecutiveErrors = 0;
  let consecutive429Errors = 0;
  let lastProgressTime = Date.now();
  const itemsToProcess = Object.entries(incomingItems);
  let currentIndex = 0;
  
  const processedInThisRun = new Set();
  let newItemsProcessed = 0;
  let itemsRegenerated = 0;
  let itemsSkippedUpToDate = 0;
  let itemsSkippedIntentional = 0;
  let itemsFailed = 0;

  console.error(`--> Checking ${itemsToProcess.length} total items...`);

  while (currentIndex < itemsToProcess.length) {
    const [id, item] = itemsToProcess[currentIndex];

    if (Date.now() - startTime > BatchConfig.timeoutMs) {
      console.error(`--> Time limit of ${BatchConfig.timeoutMs / 1000 / 60} minutes exceeded. Stopping current batch.`);
      break;
    }

    const existingVersion = existingObjectsVersions.get(id) || 0;
    if (existingVersion >= IMPLEMENTATION_VERSION) {
      if (isDebug) {
        console.log(`DEBUG: [${id}] Skipping. Existing version (${existingVersion}) is up-to-date with current version (${IMPLEMENTATION_VERSION}).`);
      }
      itemsSkippedUpToDate++;
      currentIndex++;
      continue; // Already processed with current or newer version
    }

    if (existingVersion > 0) {
        if (isDebug) {
            console.log(`DEBUG: [${id}] Processing. Regenerating due to version mismatch (existing: ${existingVersion}, current: ${IMPLEMENTATION_VERSION}).`);
        }
    } else {
        if (isDebug) {
            console.log(`DEBUG: [${id}] Processing. New item.`);
        }
    }

    const result = await processSingleItem (id, item);

    if (result?.rateLimited) {
      consecutiveErrors = 0;
      consecutive429Errors++;
      
      if (consecutive429Errors >= BatchConfig.consecutive429Threshold) {
        console.warn(`--> Aborting due to ${consecutive429Errors} consecutive 429 errors. This is considered a normal stop.`);
        break;
      }
      
      let sleepTime = BatchConfig.initialSleepMsOn429 * Math.pow(2, consecutive429Errors - 1);
      sleepTime = Math.min(sleepTime, BatchConfig.maxSleepMsOn429);
      sleepTime += Math.random() * 1000; // Jitter
      
      console.warn(`--> Sleeping for ${Math.round(sleepTime)}ms due to 429 error...`);
      await sleep(sleepTime);
      
      continue; // Retry the same item
    }
    consecutive429Errors = 0;

    if (result.skipped) { // Skipped with a reason
      if (isDebug) {
        console.log(`DEBUG: [${id}] Skipped: ${result.reason}`);
      }
      itemsSkippedIntentional++;
      currentIndex++;
      continue;
    }

    if (result.failed) {
      if (isDebug) {
        console.log(`DEBUG: [${id}] Failed to process.`);
      }
      missingIdentifiers.add(id);
      itemsFailed++;
      consecutiveErrors++;
      if (consecutiveErrors >= BatchConfig.errorThreshold) {
          console.error(`--> Aborting after ${consecutiveErrors} consecutive errors.`);
          fs.writeFileSync(missingFile, Array.from(missingIdentifiers).join('\n'), 'utf8');
          throw new Error(`Aborting due to ${consecutiveErrors} consecutive processing errors.`);
      }
      currentIndex++;
      continue;
    }
    
    consecutiveErrors = 0;

    fs.mkdirSync (path.dirname (result.objectFile), { recursive: true });
    fs.writeFileSync (result.objectFile, result.buffer);

    if (existingVersion > 0) {
      itemsRegenerated++;
    } else {
      newItemsProcessed++;
    }

    processedInThisRun.add(id);
    existingObjectsVersions.set(id, IMPLEMENTATION_VERSION);
    
    missingIdentifiers.delete(id);
    currentIndex++;

    const now = Date.now();
    if (now - lastProgressTime > BatchConfig.progressIntervalMs) {
      const elapsedSeconds = Math.round((now - startTime) / 1000);
      console.error(`--> Progress: ${currentIndex} of ${itemsToProcess.length} items checked in ${elapsedSeconds} seconds.`);
      lastProgressTime = now;
    }
  } // while

  fs.writeFileSync(missingFile, Array.from(missingIdentifiers).join('\n'), 'utf8');

  if (processedInThisRun.size > 0) {
    console.error('--> Writing updated index file...');
    const currentSetItems = new Map();
    if (fs.existsSync(currentIndexFile)) {
      const lines = fs.readFileSync(currentIndexFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const [id, versionStr] = line.split('\t');
        const version = versionStr ? parseInt(versionStr, 10) : 0;
        if (id) {
          currentSetItems.set(id, version);
        }
      }
    }
    for (const id of processedInThisRun) {
      currentSetItems.set(id, IMPLEMENTATION_VERSION);
    }
    const newIndexContent = [...currentSetItems.entries()]
      .map(([id, version]) => `${id}\t${version}`)
      .join('\n');
    fs.writeFileSync(currentIndexFile, newIndexContent + '\n', 'utf8');
    console.error('--> Index file updated.');
  } else {
    console.error ('--> No new or outdated items were processed.');
  }

  const totalSize = getDirectorySize (objectsDir);
  console.error (`--> Total objects size: ${totalSize} bytes.`);

  if (totalSize > BatchConfig.sizeLimitBytes) {
    console.error (`--> Size limit (${BatchConfig.sizeLimitBytes} bytes) exceeded.`);
    const nextMirrorSet = parseInt (mirrorSet, 10) + 1;
    fs.writeFileSync (path.join (indexesDir, 'set.txt'), String (nextMirrorSet), 'utf8');
    console.error (`-> Set next mirror set to: ${nextMirrorSet}`);
  }

  console.error('--> Processing summary:');
  console.error(`    - ${newItemsProcessed} new items processed.`);
  console.error(`    - ${itemsRegenerated} items regenerated.`);
  console.error(`    - ${itemsSkippedUpToDate} items skipped (up-to-date).`);
  console.error(`    - ${itemsSkippedIntentional} items skipped (not applicable).`);
  console.error(`    - ${itemsFailed} items failed.`);
  console.error(`    - ${currentIndex} out of ${itemsToProcess.length} total items checked.`);

  return existingObjectsVersions;
} // processMirrorSet

async function generateLicensesFile(allItems, processedItemIds) {
  console.error('--> Generating licenses file...');
  const licenses = new Set();

  for (const id of processedItemIds) {
    const item = allItems[id];
    if (item && item.image_source) {
      const imageSourceWithLegalModified = { ...item.image_source, legalModified: true };
      const legalInfo = Object.entries(imageSourceWithLegalModified)
        .filter(([key]) => key.startsWith('legal'))
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
      
      if (legalInfo) {
        licenses.add(legalInfo);
      }
    }
  }

  const sortedLicenses = Array.from(licenses).sort();
  const licensesContent = sortedLicenses.join('\n\n');
  const licensesFile = path.join(indexesDir, 'licenses.txt');
  fs.writeFileSync(licensesFile, licensesContent, 'utf8');
  console.error(`--> Licenses file generated at ${licensesFile} with ${sortedLicenses.length} entries.`);
} // generateLicensesFile

async function generatePartialIndexes(listData, indexesDir) {
  console.error('--> Generating partial indexes...');
  const { items, groups } = listData;

  const partialsData = {};

  for (const group of Object.values(groups)) {
    if (!group.region_refs || !group.value || !group.features) {
      continue;
    }

    const validItemIds = group.region_refs.filter(ref => items[ref]);

    if (validItemIds.length === 0) {
      continue;
    }

    const valueHexParts = [...group.value].map(c => c.codePointAt(0).toString(16));
    const featuresParts = group.features.split('.');
    const allParts = [...valueHexParts, ...featuresParts];
    const representativeId = `:u-swk-${allParts.join('-')}`;

    const partIndex = Math.floor(group.value.codePointAt(0) / 16);

    if (!partialsData[partIndex]) {
      partialsData[partIndex] = { images: {} };
    }
    
    if (partialsData[partIndex].images[representativeId]) {
       console.warn(`--> Duplicate representativeId found: ${representativeId}. Merging item lists.`);
       partialsData[partIndex].images[representativeId].push(...validItemIds);
    } else {
       partialsData[partIndex].images[representativeId] = validItemIds;
    }
  }

  const partialsDir = path.join(indexesDir, 'imageindex');
  try {
    fs.mkdirSync(partialsDir, { recursive: true });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  let filesWritten = 0;
  for (const [partIndex, data] of Object.entries(partialsData)) {
    const filename = `part-${partIndex}.json`;
    const filePath = path.join(partialsDir, filename);
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      filesWritten++;
    } catch (e) {
      console.error(`--> Failed to write partial index file ${filePath}: ${e.message}`);
    }
  }

  if (filesWritten > 0) {
    console.error(`--> Successfully generated ${filesWritten} partial index files in ${partialsDir}.`);
  } else {
    console.error('--> No partial index files were generated.');
  }
} // generatePartialIndexes

async function main () {
  const mirrorSet = process.argv[2];
  if (!mirrorSet || !/^[0-9]+$/.test (mirrorSet)) {
    console.error (`Usage: node ${path.basename (__filename)} <mirror_set_id>`);
    process.exit (1);
  }

  try {
    fs.mkdirSync (indexesDir, { recursive: true });
    fs.mkdirSync (objectsDir, { recursive: true });
    const listData = await fetchListData();
    const processedItems = await processMirrorSet (mirrorSet, listData.items);
    await generateLicensesFile(listData.items, processedItems.keys());
    await generatePartialIndexes(listData, indexesDir);
    console.error (`-> Batch process for mirror set ${mirrorSet} completed successfully.`);
  } catch (error) {
    console.error (`FATAL: ${error.message}`);
    console.error (error);
    process.exit (1);
  }
} // main

main ();

/*

Copyright 2026 Wakaba <wakaba@suikawiki.org>.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see
<https://www.gnu.org/licenses/>.

*/
