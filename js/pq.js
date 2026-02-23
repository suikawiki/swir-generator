export const PQ = {env: {}};

// PQ.env.createCanvas
// PQ.env.createImg
// PQ.env.parseHTML

  PQ.BoundingBox = function () {
    this.minX = this.minY = +Infinity;
    this.maxX = this.maxY = -Infinity;
    this.width = this.height = 0;
    this.centerPoint = [NaN, NaN];
  };

  PQ.BoundingBox.prototype.addPoints = function (pts) {
    pts.forEach (pt => {
      if (pt[0] < this.minX) this.minX = pt[0];
      if (pt[1] < this.minY) this.minY = pt[1];
      if (this.maxX < pt[0]) this.maxX = pt[0];
      if (this.maxY < pt[1]) this.maxY = pt[1];
    });
    this.width = this.maxX - this.minX + 1;
    this.height = this.maxY - this.minY + 1;
    this.centerPoint = [Math.floor (this.minX + this.width/2),
                        Math.floor (this.minY + this.height/2)];
  }; // addPoints

  PQ.BoundingBox.prototype.addBoundingBox = function (bb) {
    if (bb.width && bb.height) this.addPoints ([
      [bb.minX, bb.minY],
      [bb.maxX, bb.maxY],
    ]);
  }; // addBoundingBox

  PQ.Path = function () { };

  PQ.Path.fromPoints = function (pts) {
    let p = new PQ.Path ();
    p._pts = pts;
    return p;
  }; // PQ.Path.fromPoints

  PQ.Path.prototype.toPath2D = function (opts = {}) {
    let p = new Path2D ('M' + this._pts.join (' '));

    if (opts.matrix) {
      let q = new Path2D;
      q.addPath (p, opts.matrix);
      p = q;
    }

    return p;
  }; // toPath2D


  PQ.RegionBoundary = function () {};

  PQ.RegionBoundary.fromArray = function (array) {
    let rb = new PQ.RegionBoundary;
    rb.array = array;
    rb.boundingBox = PQ.RegionBoundary._getBoundingBox (array);
    return rb;
  }; // PQ.RegionBoundary.fromArray

  PQ.RegionBoundary._getBoundingBox = rb => {
    let xx = [];
    let yy = [];
    let bb = new PQ.BoundingBox;
    rb.forEach (paths => bb.addPoints (paths[0]));
    return bb;
  }; // PQ.RegionBoundary._getBoundingBox

  PQ.RegionBoundary.prototype.getRegionKey = async function () {
    let json = JSON.stringify (this.array);
    if (json === "[]") return null;
    let data = (new TextEncoder).encode (json);
    let buffer = await crypto.subtle.digest ("SHA-256", data);
    return Array.from (new Uint8Array (buffer)).slice (0, 5).map (b => b.toString (16).padStart (2, '0')).join ('');
  }; // getRegionKey


PQ.Image = function () {
  //
};

PQ.Image.fromImg = function (img, {orientation = 1}) {
  let self = new PQ.Image;
  self.orientation = orientation;
  self._img = img;
  self.physicalWidth = img.naturalWidth;
  self.physicalHeight = img.naturalHeight;
  return self;
}; // PQ.Image.fromImg

PQ.Image.fromImageData = function (imageData, {orientation = 1}) {
  let self = new PQ.Image;
  self.orientation = orientation;
  self._imageData = imageData;
  self.physicalWidth = imageData.width;
  self.physicalHeight = imageData.height;
  return self;
}; // PQ.Image.fromImageData

Object.defineProperty (PQ.Image.prototype, 'width', {
  get: function () { return this.orientation >= 5 ? this.physicalHeight : this.physicalWidth },
});
Object.defineProperty (PQ.Image.prototype, 'height', {
  get: function () { return this.orientation >= 5 ? this.physicalWidth : this.physicalHeight },
});

PQ.Image.prototype._getForBox = function (bb) {
  const { minX, minY, width: w, height: h } = bb;
  const W = this.physicalWidth;
  const H = this.physicalHeight;
    switch (this.orientation) {
      case 2: return { minX: W - minX - w, minY, width: w, height: h };
      case 3: return { minX: W - minX - w, minY: H - minY - h, width: w, height: h };
      case 4: return { minX, minY: H - minY - h, width: w, height: h };
      case 5: return { minX: minY, minY: minX, width: h, height: w };
      case 6: return { minX: minY, minY: H - (minX + w), width: h, height: w };
      case 7: return { minX: W - (minY + h), minY: H - (minX + w), width: h, height: w };
      case 8: return { minX: W - (minY + h), minY: minX, width: h, height: w };
     default: return { minX, minY, width: w, height: h };
    }
  }; // _getForBox
    
PQ.Image.prototype.drawFragment = async function (ctx, width, height, inBox) {
  const srcBox = this._getForBox (inBox);
    
    ctx.save ();

    switch (this.orientation) {
    case 2:
      ctx.translate (width, 0);
      ctx.scale (-1, 1);
      break;
    case 3:
      ctx.translate (width, height);
      ctx.rotate (Math.PI);
      break;
    case 4:
      ctx.translate (0, height);
      ctx.scale (1, -1);
      break;
    case 5:
      ctx.rotate (-Math.PI / 2);
      ctx.scale (-1, 1);
      break;
    case 6:
      ctx.translate (width, 0);
      ctx.rotate (Math.PI / 2);
      break;
    case 7:
      ctx.translate (width, height);
      ctx.rotate (Math.PI / 2);
      ctx.scale (-1, 1);
      break;
    case 8:
      ctx.translate (0, height);
      ctx.rotate (-Math.PI / 2);
      break;
  }

  let img = this._img;
  if (!img && this._imageData) {
    if (globalThis.createImageBitmap) {
      img = this._img = await createImageBitmap (this._imageData);
    } else {
      img = this._img = PQ.env.createCanvas (this._imageData.width, this._imageData.height);
      let x = img.getContext ('2d');
      x.putImageData (this._imageData, 0, 0);
    }
  }
  if (this.orientation >= 5) {
    ctx.drawImage (
      img,
      srcBox.minX, srcBox.minY, srcBox.width, srcBox.height,
      0, 0, height, width,
    );
  } else {
    ctx.drawImage (
      img,
      srcBox.minX, srcBox.minY, srcBox.width, srcBox.height,
      0, 0, width, height,
    );
  }
  
  ctx.restore ();
}; // PQ.Image.prototype.drawFragment


PQ.Image.prototype.getClippedCanvasByRegionBoundary = function (rb) {
  let bb = rb.boundingBox;

  let destCanvas = PQ.env.createCanvas (bb.width, bb.height);
  let destCtx = destCanvas.getContext ('2d');

  rb.array.forEach (paths => {
    let canvas = PQ.env.createCanvas (bb.width, bb.height);
    let ctx = canvas.getContext ('2d');

    ctx.fillStyle = "black";
    paths.forEach (path => {
      ctx.beginPath ();
      ctx.moveTo (path[0][0] - bb.minX, path[0][1] - bb.minY);
      path.forEach (([x, y], j) => ctx.lineTo (x - bb.minX, y - bb.minY));
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
    });

    ctx.globalCompositeOperation = "source-in";
    this.drawFragment (ctx, bb.width, bb.height, bb);
    
    destCtx.drawImage (canvas, 0, 0);
  });

  return destCtx;
}; // PQ.Image.prototype.getClippedCanvasByRegionBoundary

PQ.Image._insertXMPIntoJPEG = function(jpegInput, xmpXmlString) {
    function concatUint8Arrays(...arrays) {
        const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const arr of arrays) {
          result.set(arr, offset);
          offset += arr.length;
        }
        return result;
    }

    let jpeg;
    if (jpegInput instanceof Uint8Array) {
      jpeg = jpegInput;
    } else if (jpegInput instanceof ArrayBuffer) {
      jpeg = new Uint8Array(jpegInput);
    } else if (typeof Buffer !== "undefined" && jpegInput instanceof Buffer) {
      jpeg = new Uint8Array(jpegInput);
    } else {
      throw new Error("Unsupported input type");
    }
  
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new Error("Not a valid JPEG (missing SOI)");
    }
  
    const encoder = new TextEncoder();
    const xmpHeader = encoder.encode("http://ns.adobe.com/xap/1.0/\0");
    const xmpBody = encoder.encode(xmpXmlString);
  
    const xmpPayload = concatUint8Arrays(xmpHeader, xmpBody);
  
    const app1Marker = new Uint8Array([0xff, 0xe1]);
  
    const length = xmpPayload.length + 2;
    const lengthBytes = new Uint8Array(2);
    lengthBytes[0] = (length >> 8) & 0xff;
    lengthBytes[1] = length & 0xff;
  
    const app1Segment = concatUint8Arrays(
      app1Marker,
      lengthBytes,
      xmpPayload
    );
  
    return concatUint8Arrays(
      jpeg.slice(0, 2),
      app1Segment,
      jpeg.slice(2)
    );
}

PQ.Image._insertXMPIntoPNG = function(pngInput, xmpXmlString) {
    function concatUint8Arrays(...arrays) {
        const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const arr of arrays) {
          result.set(arr, offset);
          offset += arr.length;
        }
        return result;
    }

    const crcTable = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
          let c = i;
          for (let k = 0; k < 8; k++) {
            c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
          }
          table[i] = c >>> 0;
        }
        return table;
    })();
      
    function crc32(data) {
        let crc = 0xffffffff;
        for (let i = 0; i < data.length; i++) {
          crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    let png;
    if (pngInput instanceof Uint8Array) {
      png = pngInput;
    } else if (pngInput instanceof ArrayBuffer) {
      png = new Uint8Array(pngInput);
    } else if (typeof Buffer !== "undefined" && pngInput instanceof Buffer) {
      png = new Uint8Array(pngInput);
    } else {
      throw new Error("Unsupported input type");
    }
  
    const pngSignature = [137,80,78,71,13,10,26,10];
    for (let i = 0; i < 8; i++) {
      if (png[i] !== pngSignature[i]) {
        throw new Error("Not a valid PNG");
      }
    }
  
    const encoder = new TextEncoder();
  
    const keyword = encoder.encode("XML:com.adobe.xmp");
    const nullByte = new Uint8Array([0]);
  
    const compressionFlag = new Uint8Array([0]);
    const compressionMethod = new Uint8Array([0]);
  
    const languageTag = nullByte;
    const translatedKeyword = nullByte;
  
    const textData = encoder.encode(xmpXmlString);
  
    const iTXtData = concatUint8Arrays(
      keyword,
      nullByte,
      compressionFlag,
      compressionMethod,
      languageTag,
      translatedKeyword,
      textData
    );
  
    const createChunk = (type, data) => {
      const typeBytes = encoder.encode(type);
      const length = data.length;
      const chunk = new Uint8Array(4 + 4 + length + 4);

      chunk[0] = (length >>> 24) & 0xff;
      chunk[1] = (length >>> 16) & 0xff;
      chunk[2] = (length >>> 8) & 0xff;
      chunk[3] = length & 0xff;
    
      chunk.set(typeBytes, 4);
      chunk.set(data, 8);
    
      const crc = crc32(concatUint8Arrays(typeBytes, data));
      const crcOffset = 8 + length;
    
      chunk[crcOffset]     = (crc >>> 24) & 0xff;
      chunk[crcOffset + 1] = (crc >>> 16) & 0xff;
      chunk[crcOffset + 2] = (crc >>> 8) & 0xff;
      chunk[crcOffset + 3] = crc & 0xff;
    
      return chunk;
    }
  
    const iTXtChunk = createChunk("iTXt", iTXtData);
    const ihdrEnd = 33;
  
    return concatUint8Arrays(
      png.slice(0, ihdrEnd),
      iTXtChunk,
      png.slice(ihdrEnd)
    );
}

PQ.Image.SerializeCanvas = async function (canvas, info, { type = "image/png", allowMissingLegalKey = false } = {}) {
  info = info || {};
  if (!allowMissingLegalKey && !info.legalKey) {
    throw new Error("legalKey is required unless allowMissingLegalKey is set to true.");
  }

  const inputBuffer = canvas.toBuffer (type);

  const xmpParts = [];
  const dlTagNames = [];

  const SPDX_TO_URL = {
    "CC-PDM-1.0": "https://creativecommons.org/publicdomain/mark/1.0/deed.ja",
    "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/deed.ja",
    "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/deed.ja",
  };

  const escapeXml = (str) => {
    if (typeof str !== 'string') return '';
    return str.replace (/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case "'": return '&apos;';
        case '"': return '&quot;';
      }
    });
  }; // escapeXml
  
  info = info || {};
  const langAttr = info.legalLang != null ? ` xml:lang="${escapeXml (info.legalLang)}"` : '';

  if (info.legalKey) {
    const url = SPDX_TO_URL[info.legalKey];
    if (url) {
      xmpParts.push (`<cc:license rdf:resource="${escapeXml (url)}"/>`);
    }
    xmpParts.push (`<dl:key>${escapeXml (info.legalKey)}</dl:key>`);
    dlTagNames.push ('dl:key');
  }

  if (info.legalTitle) {
    xmpParts.push (`<dl:title${langAttr}>${escapeXml (info.legalTitle)}</dl:title>`);
    dlTagNames.push ('dl:title');
  }

  if (info.legalHolder) {
    const holder = escapeXml (info.legalHolder);
    xmpParts.push (`<xmpRights:Owner>`);
    xmpParts.push (`<rdf:Seq>`);
    xmpParts.push (`<rdf:li${langAttr}>${holder}</rdf:li>`);
    xmpParts.push (`</rdf:Seq>`);
    xmpParts.push (`</xmpRights:Owner>`);
    xmpParts.push (`<dl:holder${langAttr}>${holder}</dl:holder>`);
    dlTagNames.push ('dl:holder');
  }

  if (info.legalDate) {
    xmpParts.push (`<dl:date${langAttr}>${escapeXml (info.legalDate)}</dl:date>`);
    dlTagNames.push ('dl:date');
  }

  if (info.legalOriginalURL) {
    xmpParts.push (`<dl:url rdf:resource="${escapeXml (info.legalOriginalURL)}"/>`);
    dlTagNames.push ('dl:url');
  }

  if (info.legalCredit) {
    xmpParts.push (`<dl:credit${langAttr}>${escapeXml (info.legalCredit)}</dl:credit>`);
    dlTagNames.push ('dl:credit');
  }

  if (info.legalLang != null) {
    xmpParts.push (`<dl:lang rdf:datatype="data:,ddsd.lang">${escapeXml (info.legalLang)}</dl:lang>`);
    dlTagNames.push ('dl:lang');
  }
  if (info.legalDir) {
    xmpParts.push (`<dl:dir rdf:datatype="data:,ddsd.dir">${escapeXml (info.legalDir)}</dl:dir>`);
    dlTagNames.push ('dl:dir');
  }
  if (info.legalWritingMode) {
    xmpParts.push (`<dl:writingMode rdf:datatype="data:,ddsd.writingMode">${escapeXml (info.legalWritingMode)}</dl:writingMode>`);
    dlTagNames.push ('dl:writingMode');
  }
  if (info.legalModified) {
    xmpParts.push (`<dl:modified rdf:datatype="http://www.w3.org/2001/XMLSchema#boolean">true</dl:modified>`);
    dlTagNames.push ('dl:modified');
  }

  if (dlTagNames.length > 0) {
    const dlTagsString = dlTagNames.join (', ') + ' を参照。';
    xmpParts.push (`<dc:rights>`);
    xmpParts.push (`<rdf:Alt>`);
    xmpParts.push (`<rdf:li xml:lang="ja">${dlTagsString}</rdf:li>`);
    xmpParts.push (`</rdf:Alt>`);
    xmpParts.push (`</dc:rights>`);
  }

  if (xmpParts.length === 0) {
    return inputBuffer;
  }

  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
`<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cc="http://creativecommons.org/ns#" xmlns:dl="data:,ddsd.legal." xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/">` +
  `<rdf:RDF>` +
    `<rdf:Description rdf:about="">` +
`${xmpParts.join ('')}` +
    `</rdf:Description>` +
  `</rdf:RDF>` +
`</x:xmpmeta>` +
`<?xpacket end="w"?>`;

  if (type === "image/jpeg") {
    return PQ.Image._insertXMPIntoJPEG(inputBuffer, xmp);
  } else if (type === "image/png") {
    return PQ.Image._insertXMPIntoPNG(inputBuffer, xmp);
  }

  return inputBuffer;
}; // PQ.Image.SerializeCanvas


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

You should have received a copy of the GNU Affero General Public
License along with this program.  If not, see
<https://www.gnu.org/licenses/>.

*/
