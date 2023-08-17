import ReactDOM from "react-dom";
import { action, makeAutoObservable } from "mobx";
import { toDerivativeHeading, toHeading, firstDerivative } from "./Calculation";
import { FieldCanvasConverter } from "./Canvas";
import { getAppStores } from "./MainApp";
import { Vector } from "./Path";
import { clamp } from "./Util";

export class FieldEditor {
  private _offset: Vector = new Vector(0, 0);
  private _scale: number = 1; // 1 = 100%, [1..3]
  private _areaSelection: {
    from: Vector;
    to: Vector;
  } | undefined = undefined;
  private selectedBefore: string[] = []; // Selected controls before area selection
  private offsetStart: Vector | undefined = undefined;

  fcc!: FieldCanvasConverter;

  isAddingControl: boolean = false;
  isPendingShowTooltip: boolean = false;
  tooltipPosition: Vector | undefined = undefined;

  constructor() {
    makeAutoObservable(this, { fcc: false });
  }

  startAreaSelection(fromPosInPx: Vector): void { // position with offset and scale
    const { app } = getAppStores();

    this._areaSelection = {
      from: fromPosInPx,
      to: fromPosInPx,
    };
    this.selectedBefore = [...app.selectedEntityIds];
  }

  updateAreaSelection(toPosInPx: Vector): boolean { // position with offset and scale
    const { app } = getAppStores();

    if (this._areaSelection === undefined) return false;
    // UX: Select control point if mouse down on field image

    // UX: Use flushSync to prevent lagging
    // See: https://github.com/reactwg/react-18/discussions/21
    // ReactDOM.flushSync(action(() => (this._areaSelection.to = posInPx)));
    this._areaSelection.to = toPosInPx;

    const from = this.fcc.toUOL(this._areaSelection.from);
    const to = this.fcc.toUOL(toPosInPx);
    
    const fixedFrom = new Vector(Math.min(from.x, to.x), Math.min(from.y, to.y));
    const fixedTo = new Vector(Math.max(from.x, to.x), Math.max(from.y, to.y));

    // ALGO: Select all controls that are within the area
    const highlighted = app.selectableControls
      .filter(control => control.isWithinArea(fixedFrom, fixedTo))
      .map(cp => cp.uid);

    // UX: select all highlighted controls except the ones that were selected before the area selection
    // outer-excluding-join
    const selected = [...this.selectedBefore, ...highlighted].filter(
      uid => !(this.selectedBefore.includes(uid) && highlighted.includes(uid))
    );

    // remove duplicates
    app.setSelected(Array.from(new Set(selected)));
    return true;
  }

  endAreaSelection(): boolean {
    if (this._areaSelection === undefined) return false;

    this._areaSelection = undefined;
    this.selectedBefore = [];

    return true;
  }

  startGrabAndMove(posInPx: Vector): void { // position with scale
    // UX: Move field if: middle click
    this.offsetStart = posInPx;
  }

  grabAndMove(posInPx: Vector): boolean { // position with scale
    if (this.isGrabAndMove === false) return false;

    const vec = posInPx.subtract(this.offsetStart!);
    this.offsetStart = posInPx;

    return this.panning(vec);
  }

  endGrabAndMove(): boolean {
    const isGrabbing = this.isGrabAndMove;
    this.offsetStart = undefined;
    return isGrabbing;
  }

  panning(vec: Vector): boolean {
    const { app } = getAppStores();

    const newOffset = this.offset.subtract(vec);
    newOffset.x = clamp(
      newOffset.x,
      -this.fcc.pixelWidth * 0.9 + this.fcc.viewOffset.x,
      this.fcc.pixelWidth * 0.9 - this.fcc.viewOffset.x
    );
    newOffset.y = clamp(newOffset.y, -this.fcc.pixelHeight * 0.9, this.fcc.pixelHeight * 0.9);
    app.fieldEditor.offset = newOffset;
    return true;
  }

  doShowRobot(posInPx: Vector): boolean {
    const { app } = getAppStores();

    // UX: Show robot if: alt key is down and no other action is performed
    if (app.gc.showRobot === false) return false;

    if (posInPx === undefined) return false;
    const posInUOL = this.fcc.toUOL(posInPx);

    const interested = app.interestedPath();
    if (interested === undefined) return false;

    const magnetDistance = app.gc.controlMagnetDistance;

    const points = interested.cachedResult.points;

    let closestPoint = undefined;
    let closestDistance = Number.MAX_VALUE;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const distance = point.distance(posInUOL);
      if (distance < closestDistance) {
        closestPoint = point;
        closestDistance = distance;
      }
    }

    if (closestPoint !== undefined && closestDistance < magnetDistance * 4) {
      app.robot.position.setXY(closestPoint);

      const t = closestPoint.sampleT;
      const segment = closestPoint.sampleRef;
      const c0 = segment.first;
      const c3 = segment.last;

      if (app.gc.robotIsHolonomic) {
        const c3Heading = toDerivativeHeading(c0.heading, c3.heading);
        app.robot.position.heading = c0.heading + c3Heading * t;
      } else {
        const heading = toHeading(firstDerivative(closestPoint.sampleRef, closestPoint.sampleT));
        app.robot.position.heading = heading;
      }

      app.robot.position.visible = true;
    }

    return true;
  }

  doScaleField(variable: number, posInPx: Vector): boolean {
    const oldScale = this.scale;
    const oldOffset = this.offset;

    const newScale = clamp(variable, 1, 3);

    // offset is offset in Konva coordinate system (KC)
    // offsetInCC is offset in HTML Canvas coordinate system (CC)
    const offsetInCC = oldOffset.multiply(oldScale).multiply(-1);

    const canvasHalfSizeWithScale = (this.fcc.pixelHeight * oldScale) / 2;
    const newCanvasHalfSizeWithScale = (this.fcc.pixelHeight * newScale) / 2;

    // UX: Maintain zoom center at mouse pointer
    const fieldCenter = offsetInCC.add(canvasHalfSizeWithScale);
    const newFieldCenter = offsetInCC.add(newCanvasHalfSizeWithScale);
    const relativePos = posInPx.subtract(fieldCenter).divide(oldScale);
    const newPos = newFieldCenter.add(relativePos.multiply(newScale));
    const newOffsetInCC = posInPx.subtract(newPos).add(offsetInCC);
    const newOffsetInKC = newOffsetInCC.multiply(-1).divide(newScale);

    this.scale = newScale;
    this.offset = newOffsetInKC;

    return true;
  }

  reset() {
    this._areaSelection = undefined;
    this.selectedBefore = [];
    this.isAddingControl = false;
    this.offsetStart = undefined;
    this.isPendingShowTooltip = false;
    this.tooltipPosition = undefined;
    this.offset = new Vector(0, 0);
    this.scale = 1;
  }

  get offset() {
    return this._offset;
  }

  get scale() {
    return this._scale;
  }

  set offset(offset: Vector) {
    this._offset = offset;
  }

  set scale(scale: number) {
    this._scale = clamp(scale, 1, 3);
  }

  get areaSelection() {
    return this._areaSelection;
  }

  get isGrabAndMove() {
    return this.offsetStart !== undefined;
  }
}
