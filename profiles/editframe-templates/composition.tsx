/*
  Editframe React composition template
  Copy this file to start a new composition. @editframe/react components:
  - Workbench: preview canvas with toolbar and timeline (requires resolution)
  - Configuration: Editframe configuration wrapper
  - Timegroup: groups elements into a timed sequence (use as root inside Workbench)
  - Video: video source with fit mode (contain, cover, fill)
  - Audio: audio source
  - Text: text overlay — pass text as children, style via style prop
  - Captions: accessibility captions for speech audio
  Run `editframe preview` to preview, `editframe render` to produce output.
*/
import { useEffect, useRef } from "react";
import { Configuration, Timegroup, Text, Workbench } from "@editframe/react";

const EFWorkbench = Workbench as any;
const EFConfiguration = Configuration as any;
const EFTimegroup = Timegroup as any;
const EFText = Text as any;

export default function Composition() {
  const workbenchRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const wb = workbenchRef.current;
    if (!wb) return;

    const fixReplay = () => {
      const config = wb.querySelector("ef-configuration");
      const controller = (config as any)?.playback;
      if (!controller) return;

      const originalPlay = controller.play.bind(controller);
      controller.play = (opts?: any) => {
        if (!opts?.from && controller.currentTime >= controller.duration) {
          originalPlay({ from: 0, to: opts?.to });
          return;
        }
        originalPlay(opts);
      };
    };

    fixReplay();
    wb.addEventListener("playback-attached", fixReplay);
    return () => wb.removeEventListener("playback-attached", fixReplay);
  }, []);

  return (
    <EFWorkbench ref={workbenchRef} resolution="1920x1080">
      <EFConfiguration>
        <EFTimegroup
          id="root"
          duration="10s"
          mode="contain"
          style={{
            width: "1920px",
            height: "1080px",
            background: "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <EFText
            duration="10s"
            style={{
              color: "white",
              fontSize: "72px",
              textAlign: "center",
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
              opacity: "min(1, var(--ef-progress, 0) * 5)",
              transform: "scale(min(1, 0.8 + var(--ef-progress, 0) * 0.2))",
            }}
          >
            Hello, Editframe!
          </EFText>
        </EFTimegroup>
      </EFConfiguration>
    </EFWorkbench>
  );
}
