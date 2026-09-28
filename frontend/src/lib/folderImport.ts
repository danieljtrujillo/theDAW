/**
 * The LIBRARY tab's "Import folder" action: the backend asks for a folder and
 * registers every audio file in it, the list is refreshed, and the log says
 * how many tracks were added.
 *
 * The backend echoes at most 200 of the entries it created and reports the
 * full number as `created_total`, so the log line reads that number
 * (`describeFolderImport`), never the length of the echo.
 */
import { describeFolderImport, importFolder } from './mediaLibrary';
import { useLibraryStore } from '../state/libraryStore';
import { logError, logInfo } from '../state/logStore';
import { useStatusBarStore } from '../state/statusBarStore';

export async function importFolderToLibrary(): Promise<void> {
  try {
    const res = await importFolder();
    if (res.cancelled) return;
    await useLibraryStore.getState().refresh();
    logInfo('library', describeFolderImport(res));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('library', `Folder import failed: ${msg}`);
    useStatusBarStore.getState().setText(`FOLDER IMPORT FAILED: ${msg}`);
  }
}
