/*
 * Auto Archiver — File System Access layer.
 *
 * Runs only in contexts that have DOM/window (the offscreen document and the
 * setup page), never in the service worker: FileSystemWritableFileStream is
 * not available in service workers. The chosen FileSystemDirectoryHandle is
 * persisted in IndexedDB, which is shared between all extension contexts.
 *
 * Layout inside the user-chosen folder:
 *   session_2026-08-14_10-30-22/
 *     session.txt   — one line per URL: url <TAB> STATUS <TAB> time <TAB> attempts
 *     debug.log     — timestamped trace of what the extension did
 *     pages/        — the saved HTML files
 */

/* global indexedDB, fetch */

const DB_NAME = "auto-archive";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const FOLDER_KEY = "folder";
const SESSION_FILE = "session.txt";
const DEBUG_FILE = "debug.log";
const PAGES_DIR = "pages";
const TEXT_FILES = new Set([SESSION_FILE, DEBUG_FILE]);
const SESSION_PREFIX = "session_";
const LEGACY_FILES = ["queue.txt", "queue-failed.txt", "debug.log"];

// All folder operations are funneled through one promise chain so that
// concurrent saves and session.txt rewrites never interleave writes.
let operationChain = Promise.resolve();

export {
	SESSION_FILE,
	DEBUG_FILE,
	PAGES_DIR,
	getState,
	setFolderHandle,
	getFolderHandle,
	requestFolderPermission,
	createSession,
	writePage,
	readTextFile,
	writeTextFile,
	appendTextFile
};

function serialized(operation) {
	const result = operationChain.then(operation);
	operationChain = result.catch(() => { /* keep the chain alive */ });
	return result;
}

function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function withStore(mode, operation) {
	const db = await openDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE_NAME, mode);
			const request = operation(transaction.objectStore(STORE_NAME));
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
}

function getFolderHandle() {
	return withStore("readonly", store => store.get(FOLDER_KEY));
}

function setFolderHandle(handle) {
	return withStore("readwrite", store => store.put(handle, FOLDER_KEY));
}

async function getState() {
	try {
		const handle = await getFolderHandle();
		if (!handle) {
			return { configured: false, permission: "prompt", folderName: null };
		}
		const permission = await handle.queryPermission({ mode: "readwrite" });
		return { configured: true, permission, folderName: handle.name };
	} catch (error) {
		return { configured: false, permission: "prompt", folderName: null, error: error.message };
	}
}

// Needs a user gesture, i.e. only callable from the setup page.
async function requestFolderPermission() {
	const handle = await getFolderHandle();
	if (!handle) {
		return "prompt";
	}
	return handle.requestPermission({ mode: "readwrite" });
}

async function getWritableFolder() {
	const handle = await getFolderHandle();
	if (!handle) {
		throw new Error("archive_folder_not_configured");
	}
	if (await handle.queryPermission({ mode: "readwrite" }) != "granted") {
		throw new Error("archive_folder_permission_lost");
	}
	return handle;
}

async function getSessionDir(folder, session) {
	if (!session || !session.startsWith(SESSION_PREFIX)) {
		throw new Error("archive_invalid_session");
	}
	return folder.getDirectoryHandle(session);
}

// Creates the session folder (with pages/ and session.txt), returns the text
// of the most recent previous session's session.txt so unfinished entries can
// be carried over. Also removes the legacy flat queue files from the root.
function createSession(session) {
	return serialized(async () => {
		const folder = await getWritableFolder();
		let latest = null;
		for await (const entry of folder.values()) {
			if (entry.kind == "directory" && entry.name.startsWith(SESSION_PREFIX) &&
				entry.name != session && (!latest || entry.name > latest.name)) {
				latest = entry;
			}
		}
		let previousText = "";
		if (latest) {
			try {
				const fileHandle = await (await folder.getDirectoryHandle(latest.name)).getFileHandle(SESSION_FILE);
				previousText = await (await fileHandle.getFile()).text();
			} catch {
				// previous session has no session.txt — nothing to carry over
			}
		}
		const directory = await folder.getDirectoryHandle(session, { create: true });
		await directory.getDirectoryHandle(PAGES_DIR, { create: true });
		await directory.getFileHandle(SESSION_FILE, { create: true });
		for (const name of LEGACY_FILES) {
			try {
				await folder.removeEntry(name);
			} catch {
				// legacy file absent — fine
			}
		}
		return { previousText };
	});
}

async function uniqueFilename(directory, name) {
	const extensionIndex = name.lastIndexOf(".");
	const base = extensionIndex > 0 ? name.substring(0, extensionIndex) : name;
	const extension = extensionIndex > 0 ? name.substring(extensionIndex) : "";
	let candidate = name, counter = 2;
	// getFileHandle without { create } throws NotFoundError when the name is free
	for (; ;) {
		try {
			await directory.getFileHandle(candidate);
			candidate = `${base}_${counter++}${extension}`;
		} catch {
			return candidate;
		}
	}
}

function writePage(session, blobURL, filename) {
	return serialized(async () => {
		const folder = await getWritableFolder();
		const pages = await (await getSessionDir(folder, session)).getDirectoryHandle(PAGES_DIR, { create: true });
		const finalName = await uniqueFilename(pages, filename);
		const blob = await (await fetch(blobURL)).blob();
		const fileHandle = await pages.getFileHandle(finalName, { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(blob);
		await writable.close();
		return { filename: finalName, bytes: blob.size };
	});
}

function readTextFile(session, name) {
	if (!TEXT_FILES.has(name)) {
		throw new Error("archive_file_not_allowed");
	}
	return serialized(async () => {
		const folder = await getWritableFolder();
		try {
			const directory = await getSessionDir(folder, session);
			const fileHandle = await directory.getFileHandle(name);
			return (await fileHandle.getFile()).text();
		} catch {
			return "";
		}
	});
}

function writeTextFile(session, name, text) {
	if (!TEXT_FILES.has(name)) {
		throw new Error("archive_file_not_allowed");
	}
	return serialized(async () => {
		const folder = await getWritableFolder();
		const directory = await getSessionDir(folder, session);
		const fileHandle = await directory.getFileHandle(name, { create: true });
		const writable = await fileHandle.createWritable();
		await writable.write(text);
		await writable.close();
		return {};
	});
}

function appendTextFile(session, name, text) {
	if (!TEXT_FILES.has(name)) {
		throw new Error("archive_file_not_allowed");
	}
	return serialized(async () => {
		const folder = await getWritableFolder();
		const directory = await getSessionDir(folder, session);
		const fileHandle = await directory.getFileHandle(name, { create: true });
		const size = (await fileHandle.getFile()).size;
		const writable = await fileHandle.createWritable({ keepExistingData: true });
		await writable.write({ type: "write", position: size, data: text });
		await writable.close();
		return {};
	});
}
