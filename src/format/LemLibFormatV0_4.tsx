import { makeAutoObservable, reaction, action } from "mobx";
import { MainApp } from "../core/MainApp";
import { clamp, makeId } from "../core/Util";
import { Control, EndPointControl, Path, Segment, Vector } from "../core/Path";
import { UnitOfLength, UnitConverter, Quantity } from "../core/Unit";
import { GeneralConfig, PathConfig, convertGeneralConfigUOL, convertPathConfigPointDensity } from "./Config";
import { Format, PathFileData } from "./Format";
import { Box, Typography } from "@mui/material";
import { NumberRange, RangeSlider } from "../component/RangeSlider";
import { UpdateProperties } from "../core/Command";
import { Exclude } from "class-transformer";
import { PointCalculationResult, getPathPoints } from "../core/Calculation";

// observable class
class GeneralConfigImpl implements GeneralConfig {
  robotWidth: number = 12;
  robotHeight: number = 12;
  robotIsHolonomic: boolean = false;
  showRobot: boolean = false;
  uol: UnitOfLength = UnitOfLength.Inch;
  pointDensity: number = 2; // inches
  controlMagnetDistance: number = 5 / 2.54;

  @Exclude()
  private format_: LemLibFormatV0_4;

  constructor(format: LemLibFormatV0_4) {
    this.format_ = format;
    makeAutoObservable(this);

    reaction(
      () => this.uol,
      action((newUOL: UnitOfLength, oldUOL: UnitOfLength) => {
        convertGeneralConfigUOL(this, oldUOL);
      })
    );
  }

  get format() {
    return this.format_;
  }

  getConfigPanel(app: MainApp) {
    return <></>;
  }
}

// observable class
class PathConfigImpl implements PathConfig {
  speedLimit: NumberRange = {
    minLimit: { value: 0, label: "0" },
    maxLimit: { value: 127, label: "127" },
    step: 1,
    from: 20,
    to: 100
  };
  bentRateApplicableRange: NumberRange = {
    minLimit: { value: 0, label: "0" },
    maxLimit: { value: 4, label: "4" },
    step: 0.01,
    from: 1.4,
    to: 1.8
  };

  @Exclude()
  private format_: LemLibFormatV0_4;

  constructor(format: LemLibFormatV0_4) {
    this.format_ = format;
    makeAutoObservable(this);

    reaction(
      () => format.getGeneralConfig().pointDensity,
      action((val: number, oldVal: number) => {
        convertPathConfigPointDensity(this, oldVal, val);
      })
    );

    // ALGO: Convert the default parameters to the current point density
    // ALGO: This is only used when a new path is added, not when the path config is loaded
    convertPathConfigPointDensity(this, 2, format.getGeneralConfig().pointDensity);
  }

  get format() {
    return this.format_;
  }

  getConfigPanel(app: MainApp) {
    const pathUid = app.interestedPath()?.uid ?? "some-path-uid";

    return (
      <>
        <Box className="panel-box">
          <Typography>Min/Max Speed</Typography>
          <RangeSlider
            range={this.speedLimit}
            onChange={(from, to) =>
              app.history.execute(
                `Update path ${pathUid} min/max speed`,
                new UpdateProperties(this.speedLimit, { from, to })
              )
            }
          />
        </Box>
        <Box className="panel-box">
          <Typography>Bent Rate Applicable Range</Typography>
          <RangeSlider
            range={this.bentRateApplicableRange}
            onChange={(from, to) =>
              app.history.execute(
                `Update path ${pathUid} bent rate applicable range`,
                new UpdateProperties(this.bentRateApplicableRange, { from, to })
              )
            }
          />
        </Box>
      </>
    );
  }
}

// observable class
export class LemLibFormatV0_4 implements Format {
  isInit: boolean = false;
  uid: string;

  private gc = new GeneralConfigImpl(this);

  constructor() {
    this.uid = makeId(10);
    makeAutoObservable(this);
  }

  createNewInstance(): Format {
    return new LemLibFormatV0_4();
  }

  getName(): string {
    return "LemLib v0.4.x (inch, byte-voltage)";
  }

  init(): void {
    if (this.isInit) return;
    this.isInit = true;
  }

  getGeneralConfig(): GeneralConfig {
    return this.gc;
  }

  buildPathConfig(): PathConfig {
    return new PathConfigImpl(this);
  }

  getPathPoints(path: Path): PointCalculationResult {
    return getPathPoints(path, new Quantity(this.gc.pointDensity, this.gc.uol));
  }

  recoverPathFileData(fileContent: string): PathFileData {
    // ALGO: The implementation is adopted from https://github.com/LemLib/Path-Gen under the GPLv3 license.

    const paths: Path[] = [];

    // find the first line that is "endData"
    const lines = fileContent.split("\n");

    let i = lines.findIndex(line => line === "endData");
    if (i === -1) throw new Error("Invalid file format, unable to find line 'endData'");

    // i + 1 Deceleration not supported.

    const maxSpeed = Number(lines[i + 2]);
    if (isNaN(maxSpeed)) throw new Error("Invalid file format, unable to parse max speed");

    // i + 3 Multiplier not supported.

    i += 4;

    const error = () => {
      throw new Error("Invalid file format, unable to parse segment at line " + (i + 1));
    };

    const num = (str: string): number => {
      const num = Number(str);
      if (isNaN(num)) error();
      return num; // ALGO: removed fix precision
    };

    const push = (segment: Segment) => {
      // check if there is a path
      if (paths.length === 0) {
        const path = new Path(this.buildPathConfig(), segment);
        path.pc.speedLimit.to = clamp(
          maxSpeed.toUser(),
          path.pc.speedLimit.minLimit.value,
          path.pc.speedLimit.maxLimit.value
        );
        paths.push(path);
      } else {
        const path = paths[paths.length - 1];
        const lastSegment = path.segments[path.segments.length - 1];
        const a = lastSegment.last;
        const b = segment.first;

        if (a.x !== b.x || a.y !== b.y) error();

        path.segments.push(segment);
      }
    };

    while (i < lines.length - 1) {
      // ALGO: the last line is always empty, follow the original implementation.
      const line = lines[i];
      const tokens = line.split(", ");
      if (tokens.length !== 8) error();

      const p1 = new EndPointControl(num(tokens[0]), num(tokens[1]), 0);
      const p2 = new Control(num(tokens[2]), num(tokens[3]));
      const p3 = new Control(num(tokens[4]), num(tokens[5]));
      const p4 = new EndPointControl(num(tokens[6]), num(tokens[7]), 0);
      const segment = new Segment(p1, [p2, p3], p4);
      push(segment);

      i++;
    }

    return { gc: this.gc, paths };
  }

  exportPathFile(app: MainApp): string {
    // ALGO: The implementation is adopted from https://github.com/LemLib/Path-Gen under the GPLv3 license.

    let rtn = "";

    const path = app.interestedPath();
    if (path === undefined) throw new Error("No path to export");
    if (path.segments.length === 0) throw new Error("No segment to export");

    const uc = new UnitConverter(this.gc.uol, UnitOfLength.Inch);
    const density = new Quantity(this.gc.pointDensity, this.gc.uol);

    const points = getPathPoints(path, density).points;
    for (const point of points) {
      // ALGO: heading is not supported in LemLib V0.4 format.
      rtn += `${uc.fromAtoB(point.x).toUser()}, ${uc.fromAtoB(point.y).toUser()}, ${point.speed.toUser()}\n`;
    }

    if (points.length > 1) {
      /*
      Here is the original code of how the ghost point is calculated:

      ```cpp
      // create a "ghost point" at the end of the path to make stopping nicer
      const lastPoint = path.points[path.points.length-1];
      const lastControl = path.segments[path.segments.length-1].p2;
      const ghostPoint = Vector.interpolate(Vector.distance(lastControl, lastPoint) + 20, lastControl, lastPoint);
      ```

      Notice that the variable "lastControl" is not the last control point, but the second last control point.
      This implementation is different from the original implementation by using the last point and the second last point.
      */
      const last2 = points[points.length - 2]; // second last point, last point by the calculation
      const last1 = points[points.length - 1]; // last point, also the last control point
      // ALGO: The 20 inches constant is a constant value in the original LemLib-Path-Gen implementation.
      const ghostPoint = last2.interpolate(last1, last2.distance(last1) + uc.fromBtoA(20));
      rtn += `${uc.fromAtoB(ghostPoint.x).toUser()}, ${uc.fromAtoB(ghostPoint.y).toUser()}, 0\n`;
    }

    rtn += `endData\n`;
    rtn += `200\n`; // Not supported
    rtn += `${path.pc.speedLimit.to}\n`;
    rtn += `200\n`; // Not supported

    function output(control: Vector, postfix: string = ", ") {
      rtn += `${uc.fromAtoB(control.x).toUser()}, ${uc.fromAtoB(control.y).toUser()}${postfix}`;
    }

    for (const segment of path.segments) {
      if (segment.controls.length === 4) {
        output(segment.controls[0]);
        output(segment.controls[1]);
        output(segment.controls[2]);
        output(segment.controls[3], "\n");
      } else if (segment.controls.length === 2) {
        const center = segment.controls[0].add(segment.controls[1]).divide(new Vector(2, 2));
        output(segment.controls[0]);
        output(center);
        output(center);
        output(segment.controls[1], "\n");
      }
    }

    rtn += "#PATH.JERRYIO-DATA " + JSON.stringify(app.exportPathFileData());

    return rtn;
  }
}
