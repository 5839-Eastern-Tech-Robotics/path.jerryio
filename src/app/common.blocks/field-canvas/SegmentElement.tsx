import { observer } from "mobx-react-lite";
import { Path, Segment } from "@core/Path";
import { SegmentControlVisualLineElement } from "./SegmentControlVisualLineElement";
import { SegmentPointsHitBoxElement } from "./SegmentPointsHitBoxElement";
import { FieldCanvasConverter } from "@core/Canvas";

export interface SegmentElementProps {
  segment: Segment;
  path: Path;
  fcc: FieldCanvasConverter;
}

const SegmentElement = observer((props: SegmentElementProps) => {
  return (
    <>
      {/* ALGO: Do not calculate points here */}
      {props.segment.controls.length === 4 ? (
        <>
          {props.segment.controls[1].visible && (
            <SegmentControlVisualLineElement
              start={props.segment.controls[0]}
              end={props.segment.controls[1]}
              fcc={props.fcc}
            />
          )}
          {props.segment.controls[2].visible && (
            <SegmentControlVisualLineElement
              start={props.segment.controls[2]}
              end={props.segment.controls[3]}
              fcc={props.fcc}
            />
          )}
        </>
      ) : props.segment.controls.length === 6 ? (
        <>
          {props.segment.controls[1].visible && (
            <SegmentControlVisualLineElement
              start={props.segment.controls[0]}
              end={props.segment.controls[1]}
              fcc={props.fcc}
            />
          )}
          {props.segment.controls[2].visible && (
            <SegmentControlVisualLineElement
              start={props.segment.controls[1]}
              end={props.segment.controls[2]}
              fcc={props.fcc}
            />
          )}
          {props.segment.controls[3].visible && (
            <SegmentControlVisualLineElement
              start={props.segment.controls[3]}
              end={props.segment.controls[4]}
              fcc={props.fcc}
            />
          )}
          {props.segment.controls[4].visible && (
            <SegmentControlVisualLineElement
              start={props.segment.controls[5]}
              end={props.segment.controls[4]}
              fcc={props.fcc}
            />
          )}
        </>
      ) : null}
      <SegmentPointsHitBoxElement {...props} />
      {/* UX: Do not render control point here due to z-index */}
    </>
  );
});

export { SegmentElement };
