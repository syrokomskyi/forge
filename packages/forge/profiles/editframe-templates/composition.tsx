/*
  Editframe React composition template
  Copy this file to start a new composition. @editframe/react components:
  - TimelineRoot: root container for the composition
  - Timegroup: groups elements into a timed sequence
  - Video: video source with fit mode (contain, cover, fill)
  - Audio: audio source
  - Text: text overlay with positioning
  - Captions: accessibility captions for speech audio
  Run `editframe preview` to preview, `editframe render` to produce output.
*/
import {
  Configuration,
  TimelineRoot,
  Timegroup,
  Video,
  Text,
  Audio,
  Captions,
  Workbench,
} from "@editframe/react";

export default function Composition() {
  return (
    <Configuration>
      <Workbench resolution="1920x1080">
        <TimelineRoot>
          <Timegroup duration="10s">
            <Video src="assets/background.mp4" fit="contain" duration="10s" />
            <Text
              text="Your text here"
              x="50%"
              y="50%"
              fontSize="48px"
              color="white"
              textAlign="center"
              duration="5s"
            />
            <Audio src="assets/narration.mp3" />
            <Captions src="assets/captions.vtt" />
          </Timegroup>
        </TimelineRoot>
      </Workbench>
    </Configuration>
  );
}
