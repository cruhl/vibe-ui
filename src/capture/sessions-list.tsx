import { useEffect, useState } from "react";
import { listBundles, readBundle } from "./bundle.ts";
import { downloadBlob } from "./download.ts";
import { zip } from "./zip.ts";

/** Past sessions kept in this browser: watch the recording, download it, or export the bundle. */
export function SessionsList() {
  const [runIDs, setRunIDs] = useState<string[]>([]);
  const [playing, setPlaying] = useState<{ runID: string; url: string } | null>(null);
  useEffect(() => {
    void listBundles().then(setRunIDs);
  }, []);
  if (runIDs.length === 0) return null;
  const recording = async (runID: string) => (await readBundle(runID)).get("recording.webm");
  return (
    <section className="sessions-list">
      <h2>Recorded sessions</h2>
      {runIDs.map((runID) => (
        <div key={runID} className="sessions-row" data-run-id={runID}>
          <span>{runID}</span>
          <button
            type="button"
            onClick={() =>
              void recording(runID).then((blob) => {
                if (blob !== undefined) setPlaying({ runID, url: URL.createObjectURL(blob) });
              })
            }
          >
            Play
          </button>
          <button
            type="button"
            onClick={() =>
              void recording(runID).then((blob) => {
                if (blob !== undefined) downloadBlob(blob, `${runID}.webm`);
              })
            }
          >
            Download
          </button>
          <button
            type="button"
            onClick={() =>
              void readBundle(runID)
                .then(zip)
                .then((archive) => {
                  downloadBlob(archive, `${runID}.zip`);
                })
            }
          >
            Export
          </button>
        </div>
      ))}
      {playing === null ? null : (
        <video className="sessions-player" src={playing.url} controls autoPlay />
      )}
    </section>
  );
}
