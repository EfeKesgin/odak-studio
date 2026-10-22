'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Electron, ipcMain.handle içinde fırlatılan hataları renderer'a
// "Error invoking remote method 'kanal': Error: mesaj" biçiminde iletir.
// Kullanıcıya yalnızca asıl mesajı göstermek için bu öneki temizliyoruz.
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const raw = String((error && error.message) || error || '');
    const message = raw
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim();
    const clean = new Error(message || 'Bilinmeyen bir hata oluştu.');
    if (error && error.stack) clean.stack = String(error.stack);
    if (error && error.details) clean.details = error.details;
    throw clean;
  });
}

contextBridge.exposeInMainWorld('odak', {
  systemInfo: () => invoke('system:info'),
  hardware: () => invoke('system:hardware'),
  getConfig: () => invoke('config:get'),
  setConfig: (patch) => invoke('config:set', patch),
  openFiles: (payload) => invoke('dialog:open-files', payload),
  openFolder: (defaultPath) => invoke('dialog:open-folder', { defaultPath }),
  probe: (file) => invoke('media:probe', file),
  mediaUrl: (file) => invoke('media:url', file),
  poster: (payload) => invoke('media:poster', payload),
  filmstrip: (payload) => invoke('media:filmstrip', payload),
  exportVideo: (payload) => invoke('video:export', payload),
  mergeVideos: (payload) => invoke('video:merge', payload),
  exportGif: (payload) => invoke('gif:export', payload),
  previewGif: (payload) => invoke('gif:preview', payload),
  cancelJob: (jobId) => invoke('job:cancel', jobId),
  saveFrame: (payload) => invoke('video:save-frame', payload),
  photoPreview: (payload) => invoke('photo:preview', payload),
  photoExport: (payload) => invoke('photo:export', payload),
  showItem: (file) => invoke('shell:show-item', file),
  openPath: (file) => invoke('shell:open-path', file),
  about: () => invoke('app:about'),
  reload: () => invoke('app:reload'),
  updateStatus: () => invoke('update:status'),
  checkForUpdates: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  onUpdateStatus: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onJobProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
});
