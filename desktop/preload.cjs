'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const PICK_FILES_CHANNEL = 'context-master:pick-files';

/**
 * Keep the renderer API deliberately small. File paths never cross the
 * bridge; the main process owns the picker, validation, and file reads.
 */
contextBridge.exposeInMainWorld('contextMaster', {
  pickFiles: () => ipcRenderer.invoke(PICK_FILES_CHANNEL),
});
