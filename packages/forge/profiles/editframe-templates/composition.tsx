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
import {
  Configuration,
  Timegroup,
  Video,
  Text,
  Audio,
  Captions,
  Workbench,
} from "@editframe/react";

export default function Composition() {
  return (
    <Workbench resolution="1920x1080">
      <Configuration>
        <Timegroup
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
          <Video src="assets/background.mp4" fit="contain" duration="10s" />
          <Text duration="5s" style={{ color: "white", fontSize: "48px", textAlign: "center" }}>
            Your text here
          </Text>
          <Audio src="assets/narration.mp3" />
          <Captions src="assets/captions.vtt" />
        </Timegroup>
      </Configuration>
    </Workbench>
  );
}
