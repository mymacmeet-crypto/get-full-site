'use strict';

/**
 * The Web Archiver toolbar icon set, drawn from scratch.
 *
 * Chrome wants the same mark at five sizes plus nine progress frames, and an
 * icon that is only ever exported from a design tool drifts: someone tweaks
 * the 128 and the 16 quietly stays a version behind. Generating all fourteen
 * from one description keeps them the same mark, and makes a colour change a
 * one-line edit rather than fourteen re-exports.
 *
 * No image library. A PNG is a zlib stream of filtered scanlines, and zlib
 * ships with Node, so the only thing missing is a rasteriser - which for the
 * handful of shapes below is a coverage test per pixel.
 *
 *   node tools/make-extension-icons.js
 *
 * The mark: an arrow descending into a tray. It has to survive being drawn
 * 16 pixels wide next to a dozen other favicons, which rules out anything with
 * interior detail - a box with a lid reads as a grey smudge at that size, an
 * arrow still reads as an arrow.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Where Chrome loads them from. */
const OUTPUT_DIR = path.join(__dirname, '..', 'extension', 'src', 'ui', 'resources');

const SIZES = [16, 32, 48, 64, 128];
/** ui-button.js paints icon_128_wait0..8 as a save progresses. */
const WAIT_FRAMES = 9;

/**
 * Supersampling factor. Chrome scales the 128 down for some surfaces, so the
 * edges have to be genuinely smooth rather than merely small; 4x4 coverage
 * sampling costs nothing at these sizes and removes the stair-stepping on the
 * arrowhead's diagonals, which is where it would show.
 */
const SAMPLES = 4;

const BACKGROUND_TOP = [0x3b, 0x82, 0xf6];
const BACKGROUND_BOTTOM = [0x1d, 0x4e, 0xd8];
const GLYPH = [0xff, 0xff, 0xff];
/** The unfilled part of the progress bar: the mark's own blue, darkened. */
const PROGRESS_TRACK = [0x17, 0x3a, 0x9e];

/** Shapes are described in 0..1 of the icon's side, so one description fits every size. */
const CORNER_RADIUS = 0.22;
const SHAFT = { x0: 0.435, x1: 0.565, y0: 0.20, y1: 0.50 };
const HEAD = { top: 0.44, bottom: 0.66, halfWidth: 0.235 };
const TRAY = { x0: 0.235, x1: 0.765, y0: 0.735, y1: 0.815 };
/** Where the progress bar sits on the wait frames, replacing the tray. */
const BAR = { x0: 0.16, x1: 0.84, y0: 0.735, y1: 0.815 };

function inRoundedSquare(x, y, radius) {
	if (x < 0 || x > 1 || y < 0 || y > 1) return false;
	// Only the four corner boxes need the distance test; everything else is in.
	const cornerX = x < radius ? radius - x : x > 1 - radius ? x - (1 - radius) : 0;
	const cornerY = y < radius ? radius - y : y > 1 - radius ? y - (1 - radius) : 0;
	if (cornerX === 0 || cornerY === 0) return true;
	return cornerX * cornerX + cornerY * cornerY <= radius * radius;
}

function inRect(x, y, rect) {
	return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
}

/** The arrowhead: an isosceles triangle whose half-width closes to nothing at the tip. */
function inArrowHead(x, y) {
	if (y < HEAD.top || y > HEAD.bottom) return false;
	const descent = (y - HEAD.top) / (HEAD.bottom - HEAD.top);
	const halfWidth = HEAD.halfWidth * (1 - descent);
	return Math.abs(x - 0.5) <= halfWidth;
}

/**
 * The colour at one sample point, or null where the icon is transparent.
 *
 * `progress` is null for the plain mark and 0..1 for a wait frame, where the
 * tray becomes a bar that fills as the save advances.
 */
function sample(x, y, progress) {
	if (!inRoundedSquare(x, y, CORNER_RADIUS)) return null;

	const glyph = progress === null
		? inRect(x, y, SHAFT) || inArrowHead(x, y) || inRect(x, y, TRAY)
		: inRect(x, y, SHAFT) || inArrowHead(x, y);
	if (glyph) return GLYPH;

	if (progress !== null && inRect(x, y, BAR)) {
		const filled = (x - BAR.x0) / (BAR.x1 - BAR.x0) <= progress;
		return filled ? GLYPH : PROGRESS_TRACK;
	}

	// Vertical gradient, so the mark reads as lit from above at every size.
	return [
		Math.round(BACKGROUND_TOP[0] + (BACKGROUND_BOTTOM[0] - BACKGROUND_TOP[0]) * y),
		Math.round(BACKGROUND_TOP[1] + (BACKGROUND_BOTTOM[1] - BACKGROUND_TOP[1]) * y),
		Math.round(BACKGROUND_TOP[2] + (BACKGROUND_BOTTOM[2] - BACKGROUND_TOP[2]) * y)
	];
}

/** Render one icon to a raw RGBA buffer, averaging SAMPLES² points per pixel. */
function render(size, progress) {
	const pixels = Buffer.alloc(size * size * 4);
	const step = 1 / (size * SAMPLES);
	for (let row = 0; row < size; row++) {
		for (let column = 0; column < size; column++) {
			let red = 0, green = 0, blue = 0, hits = 0;
			for (let subRow = 0; subRow < SAMPLES; subRow++) {
				for (let subColumn = 0; subColumn < SAMPLES; subColumn++) {
					const x = (column * SAMPLES + subColumn + 0.5) * step;
					const y = (row * SAMPLES + subRow + 0.5) * step;
					const colour = sample(x, y, progress);
					if (colour) {
						red += colour[0];
						green += colour[1];
						blue += colour[2];
						hits++;
					}
				}
			}
			const offset = (row * size + column) * 4;
			if (hits) {
				// Premultiplied averaging would darken the antialiased rim against
				// a light toolbar; averaging only the covered samples keeps the
				// edge pixels the colour of the shape they belong to.
				pixels[offset] = Math.round(red / hits);
				pixels[offset + 1] = Math.round(green / hits);
				pixels[offset + 2] = Math.round(blue / hits);
				pixels[offset + 3] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
			}
		}
	}
	return pixels;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

let crcTable = null;
function crc32(buffer) {
	if (!crcTable) {
		crcTable = new Int32Array(256);
		for (let index = 0; index < 256; index++) {
			let value = index;
			for (let bit = 0; bit < 8; bit++) {
				value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			}
			crcTable[index] = value;
		}
	}
	let crc = -1;
	for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ -1) >>> 0;
}

function encodePng(size, pixels) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // colour type: RGBA
	// compression, filter and interlace methods: the only values PNG defines
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;

	// One filter byte per scanline. Filter 0 (none) leaves the compression to
	// zlib, which at these sizes gets within a few bytes of the adaptive
	// filters for a fraction of the code.
	const raw = Buffer.alloc(size * (size * 4 + 1));
	for (let row = 0; row < size; row++) {
		raw[row * (size * 4 + 1)] = 0;
		pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

function write(name, size, progress) {
	const file = path.join(OUTPUT_DIR, name);
	fs.writeFileSync(file, encodePng(size, render(size, progress)));
	return `${name} (${size}×${size})`;
}

function main() {
	if (!fs.existsSync(OUTPUT_DIR)) {
		throw new Error(`no such directory: ${OUTPUT_DIR}`);
	}
	const written = [];
	for (const size of SIZES) {
		written.push(write(`icon_${size}.png`, size, null));
	}
	for (let frame = 0; frame < WAIT_FRAMES; frame++) {
		written.push(write(`icon_128_wait${frame}.png`, 128, frame / (WAIT_FRAMES - 1)));
	}
	console.log(`Wrote ${written.length} icons to ${OUTPUT_DIR}`);
	for (const line of written) console.log(`  ${line}`);
}

main();
