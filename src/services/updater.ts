import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export type AvailableUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

export type UpdateProgress = {
  downloaded: number;
  total?: number;
};

/** Checks the signed GitHub Release feed configured in tauri.conf.json. */
export function checkForUpdate() {
  return check();
}

/** Downloads a verified updater bundle, then restarts into the new version. */
export async function installUpdate(
  update: AvailableUpdate,
  onProgress: (progress: UpdateProgress) => void,
) {
  let downloaded = 0;
  let total: number | undefined;

  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength;
    }

    if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress({ downloaded, total });
    }
  });

  await relaunch();
}
