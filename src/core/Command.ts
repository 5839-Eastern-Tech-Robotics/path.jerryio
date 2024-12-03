import { makeAutoObservable } from "mobx";
import { MainApp, getAppStores } from "./MainApp";
import { Logger } from "./Logger";
import {
  AnyControl,
  Control,
  EndControl,
  Keyframe,
  KeyframeList,
  KeyframePos,
  Path,
  PathStructureMemento,
  PathTreeItem,
  Segment,
  SegmentControls,
  SegmentKeyframeKey,
  SegmentVariant,
  Vector,
  applyStructureMemento,
  construct,
  createStructureMemento,
  traversal
} from "./Path";

const logger = Logger("History");

export interface Execution {
  title: string;
  command: CancellableCommand;
  time: number;
  mergeTimeout: number;
}

export interface HistoryEvent<T extends CancellableCommand> {
  readonly command: ReadonlyCommand<T>;
  readonly time: number;
  isCommandInstanceOf<TCommand extends CancellableCommand>(
    constructor: new (...args: any[]) => TCommand
  ): this is HistoryEvent<TCommand>;
}

export interface CancellableExecutionEvent<T extends CancellableCommand> extends HistoryEvent<T> {
  title: string;
  readonly command: T;
  mergeTimeout: number;
  isCancelled: boolean;
  isCommandInstanceOf<TCommand extends CancellableCommand>(
    constructor: new (...args: any[]) => TCommand
  ): this is CancellableExecutionEvent<TCommand>;
}

export interface AfterExecutionEvent<T extends CancellableCommand> extends HistoryEvent<T> {
  readonly title: string;
  readonly mergeTimeout: number;
  isCommandInstanceOf<TCommand extends CancellableCommand>(
    constructor: new (...args: any[]) => TCommand
  ): this is AfterExecutionEvent<TCommand>;
}

export interface UndoRedoEvent<T extends CancellableCommand> extends HistoryEvent<T> {
  isCommandInstanceOf<TCommand extends CancellableCommand>(
    constructor: new (...args: any[]) => TCommand
  ): this is UndoRedoEvent<TCommand>;
}

export interface HistoryEventMap<T extends CancellableCommand> {
  beforeExecution: CancellableExecutionEvent<T>;
  merge: AfterExecutionEvent<T>;
  execute: AfterExecutionEvent<T>;
  afterUndo: UndoRedoEvent<T>;
  afterRedo: UndoRedoEvent<T>;
}

export interface ExecutionEventListenersContainer<T extends CancellableCommand> {
  addEventListener<K extends keyof HistoryEventMap<T>>(
    type: K,
    listener: (event: HistoryEventMap<T>[K]) => void
  ): () => void;
  removeEventListener<K extends keyof HistoryEventMap<T>>(
    type: K,
    listener: (event: HistoryEventMap<T>[K]) => void
  ): void;
  fireEvent<K extends keyof HistoryEventMap<T>>(type: K, event: HistoryEventMap<T>[K]): void;
}

export function createExecutionEvent<T extends HistoryEvent<CancellableCommand>>(
  event: Omit<T, "isCommandInstanceOf" | "time"> & { time?: number }
) {
  return {
    ...{ time: Date.now() },
    ...event,
    isCommandInstanceOf: (constructor: new (...args: any[]) => any): boolean => {
      return event.command instanceof constructor;
    }
  };
}

export class CommandHistory implements ExecutionEventListenersContainer<CancellableCommand> {
  private lastExecution: Execution | undefined = undefined;
  private history: CancellableCommand[] = [];
  private redoHistory: CancellableCommand[] = [];
  private saveStepCounter: number = 0;
  private readonly events = new Map<keyof HistoryEventMap<CancellableCommand>, Set<Function>>();

  constructor(private readonly app: MainApp) {
    makeAutoObservable<this, "events">(this, { events: false });
  }

  addEventListener<K extends keyof HistoryEventMap<CancellableCommand>, T extends CancellableCommand>(
    type: K,
    listener: (event: HistoryEventMap<T>[K]) => void
  ): () => void {
    if (!this.events.has(type)) this.events.set(type, new Set());
    this.events.get(type)!.add(listener);

    return () => this.removeEventListener(type, listener);
  }

  removeEventListener<K extends keyof HistoryEventMap<CancellableCommand>, T extends CancellableCommand>(
    type: K,
    listener: (event: HistoryEventMap<T>[K]) => void
  ): void {
    if (!this.events.has(type)) return;
    this.events.get(type)!.delete(listener);
  }

  fireEvent(
    type: keyof HistoryEventMap<CancellableCommand>,
    event: HistoryEventMap<CancellableCommand>[keyof HistoryEventMap<CancellableCommand>]
  ) {
    if (!this.events.has(type)) return;
    for (const listener of this.events.get(type)!) {
      listener(event);
    }
  }

  execute(title: string, command: CancellableCommand, mergeTimeout = 500): void {
    const beforeEvent = createExecutionEvent<CancellableExecutionEvent<CancellableCommand>>({
      title,
      command,
      mergeTimeout,
      isCancelled: false
    });
    this.fireEvent("beforeExecution", beforeEvent);

    const { isCancelled, isCommandInstanceOf: _ignore, ...exe } = beforeEvent;
    if (isCancelled) return;

    const result = command.execute();
    if (result === false) return;

    // UX: Unselect and collapse removed items
    if (isRemovePathTreeItemsCommand(command)) {
      command.removedItems.forEach(item => this.unlink(item));
    }

    if (
      exe.title === this.lastExecution?.title &&
      isMergeable(exe.command) &&
      isMergeable(this.lastExecution.command) &&
      typeof exe.command === typeof this.lastExecution.command &&
      exe.time - this.lastExecution.time < exe.mergeTimeout &&
      this.lastExecution.command.merge(exe.command)
    ) {
      this.lastExecution.time = exe.time;

      const afterEvent = createExecutionEvent<AfterExecutionEvent<CancellableCommand>>({ ...this.lastExecution });
      this.fireEvent("merge", afterEvent);
    } else {
      this.commit();
      this.lastExecution = exe;

      logger.log("EXECUTE", exe.title);

      const afterEvent = createExecutionEvent<AfterExecutionEvent<CancellableCommand>>({ ...this.lastExecution });
      this.fireEvent("execute", afterEvent);
    }

    this.redoHistory = [];
  }

  commit(): void {
    if (this.lastExecution !== undefined) {
      this.history.push(this.lastExecution.command);
      this.saveStepCounter++;
      this.lastExecution = undefined;

      const { appPreferences } = getAppStores();
      while (this.history.length > appPreferences.maxHistory) this.history.shift();
    }
  }

  undo(): void {
    this.commit();
    const command = this.history.pop();
    if (command !== undefined) {
      command.undo();
      this.redoHistory.push(command);
      this.saveStepCounter--;

      const a = isAddPathTreeItemsCommand(command);
      const u = isUpdatePathTreeItemsCommand(command);
      const r = isRemovePathTreeItemsCommand(command);

      // UX: Set select removed or updated items
      if (r || u) {
        const selected: PathTreeItem[] = [];
        if (r) selected.push(...command.removedItems);
        if (u) selected.push(...command.updatedItems);
        this.app.setSelected(Array.from(new Set(selected)));
      }

      // UX: Collapse added items
      if (a) {
        command.addedItems.forEach(item => this.unlink(item));
      }

      const afterEvent = createExecutionEvent<UndoRedoEvent<CancellableCommand>>({ command });
      this.fireEvent("afterUndo", afterEvent);
    }
    logger.log("UNDO", this.history.length, "->", this.redoHistory.length);
  }

  redo(): void {
    const command = this.redoHistory.pop();
    if (command !== undefined) {
      command.redo();
      this.history.push(command);
      this.saveStepCounter++;

      const a = isAddPathTreeItemsCommand(command);
      const u = isUpdatePathTreeItemsCommand(command);
      const r = isRemovePathTreeItemsCommand(command);

      // UX: Set select added or updated items
      if (a || u) {
        const selected: PathTreeItem[] = [];
        if (a) selected.push(...command.addedItems);
        if (u) selected.push(...command.updatedItems);
        this.app.setSelected(Array.from(new Set(selected)));
      }

      // UX: Collapse removed items
      if (r) {
        command.removedItems.forEach(item => this.unlink(item));
      }

      const afterEvent = createExecutionEvent<UndoRedoEvent<CancellableCommand>>({ command });
      this.fireEvent("afterRedo", afterEvent);
    }
    logger.log("REDO", this.history.length, "<-", this.redoHistory.length);
  }

  clearHistory(): void {
    this.lastExecution = undefined;
    this.history = [];
    this.redoHistory = [];
    this.saveStepCounter = 0;
  }

  save(): void {
    this.commit();
    this.saveStepCounter = 0;
  }

  isModified(): boolean {
    this.commit();
    return this.saveStepCounter !== 0;
  }

  get canUndo() {
    return this.undoHistorySize !== 0 || this.lastExecution !== undefined;
  }

  get canRedo() {
    return this.redoHistorySize !== 0;
  }

  get undoHistorySize() {
    return this.history.length;
  }

  get redoHistorySize() {
    return this.redoHistory.length;
  }

  private unlink(item: PathTreeItem) {
    this.app.unselect(item);
    if (item instanceof Path) this.app.removeExpanded(item);
    if (this.app.hoverItem === item.uid) this.app.hoverItem = undefined;
  }
}

export interface Command {
  /**
   * Execute the command
   *
   * @returns true if the command was executed, false otherwise (e.g. if the command is not valid or no change is made)
   */
  execute(): void | boolean;
}

export interface MergeableCommand extends Command {
  /**
   * @param command The command to merge with
   * @returns true if the command was merged, false otherwise
   */
  merge(command: MergeableCommand): boolean;
}

export interface CancellableCommand extends Command {
  undo(): void;
  redo(): void;
}

export interface AddPathTreeItemsCommand extends Command {
  addedItems: readonly PathTreeItem[];
}

export interface UpdatePathTreeItemsCommand extends Command {
  updatedItems: readonly PathTreeItem[];
}

export interface RemovePathTreeItemsCommand extends Command {
  removedItems: readonly PathTreeItem[];
}

export function isMergeable(object: Command): object is MergeableCommand {
  return "merge" in object;
}

export function isAddPathTreeItemsCommand(object: Command): object is AddPathTreeItemsCommand {
  return "addedItems" in object;
}

export function isUpdatePathTreeItemsCommand(object: Command): object is UpdatePathTreeItemsCommand {
  return "updatedItems" in object;
}

export function isRemovePathTreeItemsCommand(object: Command): object is RemovePathTreeItemsCommand {
  return "removedItems" in object;
}

export type ReadonlyCommand<T extends Command> = Omit<Readonly<T>, "execute" | "undo" | "redo" | "merge">;

/**
 * ALGO: Assume execute() function are called before undo(), redo() and other functions defined in the class
 */

export class UpdateInstancesPropertiesExtended<TTarget> implements CancellableCommand, MergeableCommand {
  protected changed = false;
  protected _previousValue: Partial<TTarget>[] = [];

  constructor(public targets: TTarget[], public newValues: Partial<TTarget>[]) {}

  execute(): boolean {
    this._previousValue = [];
    for (let i = 0; i < this.targets.length; i++) {
      const { changed, previousValues } = this.updatePropertiesForTarget(this.targets[i], this.newValues[i]);
      this.changed = this.changed || changed;
      this._previousValue.push(previousValues);
    }

    return this.changed;
  }

  undo(): void {
    for (let i = 0; i < this.targets.length; i++) {
      this.updatePropertiesForTarget(this.targets[i], this._previousValue![i]);
    }
  }

  redo(): void {
    this.execute();
  }

  merge(latest: UpdateInstancesPropertiesExtended<TTarget>): boolean {
    // ALGO: Assume that the targets are the same and both commands are executed
    for (let i = 0; i < this.targets.length; i++) {
      this._previousValue[i] = {
        ...latest._previousValue![i],
        ...this._previousValue![i]
      };
      this.newValues = { ...this.newValues, ...latest.newValues };
    }
    return true;
  }

  protected updatePropertiesForTarget(
    target: TTarget,
    values: Partial<TTarget>
  ): { changed: boolean; previousValues: Partial<TTarget> } {
    let changed = false;
    const previousValues: Partial<TTarget> = {} as Partial<TTarget>;
    for (const key in values) {
      previousValues[key] = target[key];
      target[key] = values[key]!;
      changed = changed || target[key] !== previousValues[key];
    }

    return { changed, previousValues };
  }

  get previousValue(): readonly Partial<TTarget>[] {
    return this._previousValue;
  }
}

export class UpdateProperties<TTarget> extends UpdateInstancesPropertiesExtended<TTarget> {
  constructor(public target: TTarget, newValues: Partial<TTarget>) {
    super([target], [newValues]);
  }
}

export class UpdatePathTreeItems
  extends UpdateInstancesPropertiesExtended<PathTreeItem>
  implements UpdatePathTreeItemsCommand
{
  constructor(targets: PathTreeItem[], newValues: Partial<PathTreeItem>);
  constructor(targets: PathTreeItem[], newValues: Partial<PathTreeItem>[]);
  constructor(public targets: PathTreeItem[], newValues: Partial<PathTreeItem> | Partial<PathTreeItem>[]) {
    super(targets, Array.isArray(newValues) ? newValues : Array(targets.length).fill(newValues));
  }

  get updatedItems(): readonly PathTreeItem[] {
    return this.targets.slice();
  }
}
/*//
export class AddSegment implements CancellableCommand, AddPathTreeItemsCommand {
  protected added: PathTreeItem[] = [];

  protected _segment: Segment | undefined;

  constructor(public path: Path, public end: EndControl, public degree: number) {}

  execute(): void {
    d = this.degree;
    const p[]: AnyControl[] = [];

    if (this.path.segments.length === 0) {
      p.push(new EndControl(0, 0, 0));
      for (let i = 1; i < d; i++) {
        p.push(this.end.multiply(new Control(i/d, i/d)));
      }
      p.push(this.end);

      this._segment = new Segment(...p);
      this.added.push(...p);
    } else {
      const last = this.path.segments[this.path.segments.length - 1];
      const c = last.controls[-2];
      p.push(last);
      p.push(last.mirror(new Control(c.x, c.y)));
      const diff = this.end.subtract(last);
      for (let i = 1; i < d-1; i++) {
        p.push(last + diff.multiply(new Control(i/(d-1), i/(d-1))));
      }
      p.push(this.end);

      this._segment = new Segment(...p);
      this.added.push(...p.slice(1));
    }
    this.path.segments.push(this._segment);
  }

  undo(): void {
    this.path.segments.pop();
  }

  redo(): void {
    this.path.segments.push(this._segment!);
  }

  get addedItems(): readonly PathTreeItem[] {
    return this.added;
  }

  get segment() {
    return this._segment;
  }

  get degree() {
    return this.degree;
  }
}
//*/
export class AddQuinticSegment implements CancellableCommand, AddPathTreeItemsCommand {
  protected added: PathTreeItem[] = [];

  protected _segment: Segment | undefined;

  constructor(public path: Path, public end: EndControl) {}

  execute(): void {
    const p5 = this.end;

    if (this.path.segments.length === 0) {
      const p0 = new EndControl(0, 0, 0);
      const p1 = new Control(p0.x, p5.y);
      const p2 = p5.divide(new Control(3, 3));
      const p3 = p2.add(p2);
      const p4 = new Control(p5.x, p0.y);
      this._segment = new Segment(p0, p1, p2, p3, p4, p5);
      this.added.push(p0, p1, p2, p3, p4, p5);
    } else {
      const last = this.path.segments[this.path.segments.length - 1];
      const p0 = last.last;
      const v = last.controls[last.controls.length - 2]
        .subtract(p0)
        .multiply(new Control(last.controls.length - 1, last.controls.length - 1));
      const a =
        last.controls.length === 2
          ? new Control(0, 0)
          : p0
              .subtract(last.controls[last.controls.length - 2])
              .subtract(last.controls[last.controls.length - 2])
              .add(last.controls[last.controls.length - 3])
              .multiply(last.controls.length === 4 ? 6 : 10);
      const p1 = p0.add(v.divide(new Control(5, 5)));
      const p2 = p1
        .add(p1)
        .subtract(p0)
        .add(a.divide(new Control(10, 10)));
      const p3 = p0.add(p0).add(p5).divide(new Control(3, 3));
      const p4 = p0.add(p5).add(p5).divide(new Control(3, 3));

      this._segment = new Segment(p0, p1, p2, p3, p4, p5); //// why is p1 a vector, not a control?
      this.added.push(p1, p2, p3, p4, p5);
    }
    this.path.segments.push(this._segment);
  }

  undo(): void {
    this.path.segments.pop();
  }

  redo(): void {
    this.path.segments.push(this._segment!);
  }

  get addedItems(): readonly PathTreeItem[] {
    return this.added;
  }

  get segment() {
    return this._segment;
  }
}

export class AddCubicSegment implements CancellableCommand, AddPathTreeItemsCommand {
  protected added: PathTreeItem[] = [];

  protected _segment: Segment | undefined;

  constructor(public path: Path, public end: EndControl) {}

  execute(): void {
    const p3 = this.end;

    if (this.path.segments.length === 0) {
      const p0 = new EndControl(0, 0, 0);
      const p1 = new Control(p0.x, p3.y);
      const p2 = new Control(p3.x, p0.y);
      this._segment = new Segment(p0, p1, p2, p3);
      this.added.push(p0, p1, p2, p3);
    } else {
      const last = this.path.segments[this.path.segments.length - 1];
      const p0 = last.last;
      const v = last.controls[last.controls.length - 2]
        .subtract(p0)
        .multiply(new Control(last.controls.length - 1, last.controls.length - 1));
      const p1 = p0.add(v.divide(new Control(3, 3)));
      const p2 = p0.add(p3).divide(new Control(2, 2));

      this._segment = new Segment(p0, p1, p2, p3);
      this.added.push(p1, p2, p3);
    }
    this.path.segments.push(this._segment);
  }

  undo(): void {
    this.path.segments.pop();
  }

  redo(): void {
    this.path.segments.push(this._segment!);
  }

  get addedItems(): readonly PathTreeItem[] {
    return this.added;
  }

  get segment() {
    return this._segment;
  }
}

export class AddLinearSegment implements CancellableCommand, AddPathTreeItemsCommand {
  protected added: PathTreeItem[] = [];

  protected _segment: Segment | undefined;

  constructor(public path: Path, public end: EndControl) {}

  execute(): void {
    if (this.path.segments.length === 0) {
      this._segment = new Segment(new EndControl(0, 0, 0), this.end);
      this.added.push(...this._segment.controls);
    } else {
      const last = this.path.segments[this.path.segments.length - 1];
      this._segment = new Segment(last.last, this.end);
      this.added.push(this.end);
    }
    this.path.segments.push(this._segment);
  }

  undo(): void {
    this.path.segments.pop();
  }

  redo(): void {
    this.path.segments.push(this._segment!);
  }

  get addedItems(): readonly PathTreeItem[] {
    return this.added;
  }

  get segment() {
    return this._segment;
  }
}

export class ConvertSegment implements CancellableCommand, AddPathTreeItemsCommand, RemovePathTreeItemsCommand {
  //// WHERE STUFF ACTUALLY HAPPENS
  protected previousControls: SegmentControls | undefined;
  protected newControls: SegmentControls | undefined;
  public variant: SegmentVariant;

  constructor(public path: Path, public segment: Segment) {
    this.variant = segment.isCubic()
      ? SegmentVariant.Cubic
      : segment.isLinear()
      ? SegmentVariant.Linear
      : SegmentVariant.Quintic;
  }

  protected convertToLine(): void {
    this.segment.controls.splice(1, this.segment.controls.length - 2);
  }

  protected convertToCubic(): void {
    const index = this.path.segments.indexOf(this.segment);
    const found = index !== -1;
    if (!found) return;

    const prev: Segment | undefined = this.path.segments[index - 1];
    const next: Segment | undefined = this.path.segments[index + 1];

    const p0 = this.segment.first;
    const p3 = this.segment.last;

    let temp: Vector;

    if (prev !== undefined) {
      temp = p0.mirror(prev.controls[prev.controls.length - 2].toVector());
    } else {
      temp = p0.add(p3.toVector()).divide(new Control(2, 2));
    }
    const p1 = new Control(temp.x, temp.y);

    if (next !== undefined) {
      temp = p3.mirror(next.controls[1].toVector());
    } else {
      temp = p0.add(p3.toVector()).divide(new Control(2, 2));
    }
    const p2 = new Control(temp.x, temp.y);

    this.segment.controls = [p0, p1, p2, p3];
  }

  protected convertToQuintic(): void {
    const index = this.path.segments.indexOf(this.segment);
    const found = index !== -1;
    if (!found) return;

    const prev: Segment | undefined = this.path.segments[index - 1];
    const next: Segment | undefined = this.path.segments[index + 1];

    const p0 = this.segment.first;
    const p5 = this.segment.last;

    let temp: Vector;

    if (prev !== undefined) {
      temp = p0.mirror(prev.controls[prev.controls.length - 2].toVector());
    } else {
      temp = p0.add(p5.toVector()).divide(new Control(2, 2));
    }
    const p1 = new Control(temp.x, temp.y);

    if (next !== undefined) {
      temp = p5.mirror(next.controls[1].toVector());
    } else {
      temp = p0.add(p5.toVector()).divide(new Control(2, 2));
    }
    const p4 = new Control(temp.x, temp.y);

    const p2 = p0.add(p0.toVector()).add(p5.toVector()).divide(new Control(3, 3));
    const p3 = p0.add(p5.toVector()).add(p5.toVector()).divide(new Control(3, 3));

    this.segment.controls = [p0, p1, p2, p3, p4, p5];
  }

  execute(): void {
    this.previousControls = [...this.segment.controls];
    if (this.variant === SegmentVariant.Linear) {
      this.convertToLine();
    } else if (this.variant === SegmentVariant.Cubic) {
      this.convertToCubic();
    } else if (this.variant === SegmentVariant.Quintic) {
      this.convertToQuintic();
    }
    this.newControls = [...this.segment.controls];
  }

  undo(): void {
    this.segment.controls = [...this.previousControls!];
  }

  redo(): void {
    this.segment.controls = [...this.newControls!];
  }

  get addedItems(): readonly PathTreeItem[] {
    if (this.newControls === undefined) return [];
    return this.variant === SegmentVariant.Linear ? [] : this.newControls!.slice(1, -1);
  }

  get removedItems(): readonly PathTreeItem[] {
    if (this.previousControls === undefined) return [];
    return this.variant === SegmentVariant.Linear ? this.previousControls!.slice(1, -1) : [];
  }
}

export class LockC1 implements CancellableCommand {
  //// my C1 continuity locker
  public segment: Segment;
  public variant: SegmentVariant;
  public last: Segment;
  protected previousControls: [SegmentControls, SegmentControls] | undefined;
  protected newControls: [SegmentControls, SegmentControls] | undefined;

  constructor(public path: Path, public knot: EndControl) {
    this.segment = new Segment();
    let detected = false;
    for (let i = 1; i < path.segments.length; i++) {
      if (path.segments[i].controls[0] !== knot) continue;
      detected = true;
      this.segment = path.segments[i];
    }
    this.variant = this.segment.isQuintic()
      ? SegmentVariant.Quintic
      : this.segment.isCubic()
      ? SegmentVariant.Cubic
      : this.segment.isLinear()
      ? SegmentVariant.Linear
      : SegmentVariant.Quintic;
    this.last = this.path.segments[this.path.segments.indexOf(this.segment) - 1];
    if (!detected) return;
  }

  execute(): void {
    const p0 = this.segment.first;
    this.previousControls = [[...this.last.controls], [...this.segment.controls]];
    if (this.variant === SegmentVariant.Linear) {
      //// only linear segments can influence backwards, and can't influence other linears to prevent cascading
      if (this.last.isLinear()) return;
      const v = this.segment.last.subtract(this.segment.first);
      this.last.controls[this.last.controls.length - 2] = p0.subtract(
        v.divide(new Control(this.last.controls.length - 1, this.last.controls.length - 1))
      );
      this.last.controls[this.last.controls.length - 2].lock = true;
    } else {
      const v = p0
        .subtract(this.last.controls[this.last.controls.length - 2])
        .multiply(new Control(this.last.controls.length - 1, this.last.controls.length - 1));
      this.segment.controls[1] = p0.add(
        v.divide(new Control(this.segment.controls.length - 1, this.segment.controls.length - 1))
      );
      this.segment.controls[1].lock = true;
    }
    this.newControls = [[...this.last.controls], [...this.segment.controls]];
  }

  undo(): void {
    if (this.previousControls === undefined) return;
    this.segment.controls = [...this.previousControls[1]!] as SegmentControls;
    this.last.controls = [...this.previousControls[0]!] as SegmentControls;
  }

  redo(): void {
    if (this.newControls === undefined) return;
    this.segment.controls = [...this.newControls[1]!] as SegmentControls;
    this.last.controls = [...this.newControls[0]!] as SegmentControls;
  }
}

export class LockC2 implements CancellableCommand {
  //// my C2 continuity locker
  public segment: Segment;
  public variant: SegmentVariant;
  public last: Segment;
  protected previousControls: [SegmentControls, SegmentControls] | undefined;
  protected newControls: [SegmentControls, SegmentControls] | undefined;

  constructor(public path: Path, public knot: EndControl) {
    this.segment = new Segment();
    let detected = false;
    for (let i = 1; i < path.segments.length; i++) {
      if (path.segments[i].controls[0] !== knot) continue;
      detected = true;
      this.segment = path.segments[i];
    }
    this.variant = this.segment.isQuintic()
      ? SegmentVariant.Quintic
      : this.segment.isCubic()
      ? SegmentVariant.Cubic
      : this.segment.isLinear()
      ? SegmentVariant.Linear
      : SegmentVariant.Quintic;
    this.last = this.path.segments[this.path.segments.indexOf(this.segment) - 1];
    if (!detected) return;
  }

  execute(): void {
    const p0 = this.segment.first;
    this.previousControls = [[...this.last.controls], [...this.segment.controls]];
    if (this.variant === SegmentVariant.Linear) {
      //// only linear segments can influence backwards, and can't influence other linears to prevent cascading
      if (this.last.isLinear()) return;
      const v = this.segment.last.subtract(this.segment.first);
      this.last.controls[this.last.controls.length - 2] = p0.subtract(
        v.divide(new Control(this.last.controls.length - 1, this.last.controls.length - 1))
      );
      this.last.controls[this.last.controls.length - 2].lock = true;
      const pn1 = this.last.controls[this.last.controls.length - 2];
      this.last.controls[this.last.controls.length - 3] = pn1.mirror(p0);
      this.last.controls[this.last.controls.length - 3].lock = true;
    } else {
      if (this.variant === SegmentVariant.Cubic && this.last.isCubic()) return; //// cubic segments can't influence other cubics to prevent cascading
      //// the most cascading that could happen is linear/quintic -> cubic -> quintic
      const v = p0
        .subtract(this.last.controls[this.last.controls.length - 2])
        .multiply(new Control(this.last.controls.length - 1, this.last.controls.length - 1));
      this.segment.controls[1] = p0.add(
        v.divide(new Control(this.segment.controls.length - 1, this.segment.controls.length - 1))
      );
      this.segment.controls[1].lock = true;
      const p1 = this.segment.controls[1];
      if (!this.last.isLinear()) {
        const pn1 = this.last.controls[this.last.controls.length - 2];
        const pn2 = this.last.controls[this.last.controls.length - 3];
        const a = p0
          .subtract(pn1)
          .subtract(pn1.subtract(pn2))
          .multiply(this.last.isCubic() ? 6 : 10);
        this.segment.controls[2] = p1.add(p1).subtract(new Control(p0.x, p0.y));
        this.segment.controls[2] = a
          .divide(new Control(this.segment.isCubic() ? 6 : 10, this.segment.isCubic() ? 6 : 10))
          .subtract(p0)
          .add(p1)
          .add(p1);
        this.segment.controls[2]!.lock = true;
      }
      this.segment.controls[2] = p1.add(p1).subtract(new Control(p0.x, p0.y));
      this.segment.controls[2]!.lock = true;
    }
    this.newControls = [[...this.last.controls], [...this.segment.controls]];
  }

  undo(): void {
    if (this.previousControls === undefined) return;
    this.segment.controls = [...this.previousControls[1]!] as SegmentControls;
    this.last.controls = [...this.previousControls[0]!] as SegmentControls;
  }

  redo(): void {
    if (this.newControls === undefined) return;
    this.segment.controls = [...this.newControls[1]!] as SegmentControls;
    this.last.controls = [...this.newControls[0]!] as SegmentControls;
  }
}

export class SplitSegment implements CancellableCommand, AddPathTreeItemsCommand {
  protected added: PathTreeItem[] = [];

  protected previousOriginalSegmentControls: SegmentControls | undefined;
  protected newOriginalSegmentControls: SegmentControls | undefined;
  protected _newSegment: Segment | undefined;

  constructor(public path: Path, public originalSegment: Segment, public point: EndControl) {}

  execute(): void {
    this.previousOriginalSegmentControls = [...this.originalSegment.controls];

    const index = this.path.segments.indexOf(this.originalSegment);
    const found = index !== -1;
    if (!found) return;

    const cp_count = this.originalSegment.controls.length;
    if (cp_count === 2) {
      const last = this.originalSegment.last;
      this.originalSegment.last = this.point;
      this._newSegment = new Segment(this.point, last);
      this.path.segments.splice(index + 1, 0, this._newSegment);

      this.added = [this.point];
    } else if (cp_count === 4) {
      const p0 = this.originalSegment.controls[0] as EndControl;
      const p1 = this.originalSegment.controls[1];
      const p2 = this.originalSegment.controls[2];
      const p3 = this.originalSegment.controls[3] as EndControl;

      const a = p1.divide(new Control(2, 2)).add(this.point.divide(new Control(2, 2)));
      const b = this.point;
      const c = p2.divide(new Control(2, 2)).add(this.point.divide(new Control(2, 2)));
      this.originalSegment.controls = [p0, p1, a, b];
      this._newSegment = new Segment(b, c, p2, p3);
      this.path.segments.splice(index + 1, 0, this._newSegment);

      this.added = [a, this.point, c];
    } else {
      const p0 = this.originalSegment.controls[0] as EndControl;
      const p1 = this.originalSegment.controls[1];
      const p2 = this.originalSegment.controls[2];
      const p3 = this.originalSegment.controls[3];
      const p4 = this.originalSegment.controls[4];
      const p5 = this.originalSegment.controls[5] as EndControl;

      const a1 = p2.add(p2).add(this.point).divide(new Control(3, 3));
      const a2 = p2.add(this.point).add(this.point).divide(new Control(3, 3));
      const b = this.point;
      const c1 = this.point.add(this.point).add(p3).divide(new Control(3, 3));
      const c2 = this.point.add(p3).add(p3).divide(new Control(3, 3));
      this.originalSegment.controls = [p0, p1, p2, a1, a2, b];
      this._newSegment = new Segment(b, c1, c2, p3, p4, p5);
      this.path.segments.splice(index + 1, 0, this._newSegment);
    }

    this.newOriginalSegmentControls = [...this.originalSegment.controls];
  }

  undo(): void {
    this.originalSegment.controls = this.previousOriginalSegmentControls!;
    const index = this.path.segments.indexOf(this._newSegment!);
    this.path.segments.splice(index, 1);
  }

  redo(): void {
    // this.execute();
    // ALGO: Instead of executing, we just add the segment back
    // ALGO: Assume that the command is executed
    const index = this.path.segments.indexOf(this.originalSegment);
    this.originalSegment.controls = [...this.newOriginalSegmentControls!];
    this.path.segments.splice(index + 1, 0, this._newSegment!);
  }

  get addedItems(): readonly PathTreeItem[] {
    return this.added;
  }

  get newSegment() {
    return this._newSegment;
  }
}

export class DragControls implements CancellableCommand, MergeableCommand, UpdatePathTreeItemsCommand {
  constructor(public main: AnyControl, public from: Vector, public to: Vector, public followers: AnyControl[]) {}

  execute(): void {
    const offsetX = this.to.x - this.from.x;
    const offsetY = this.to.y - this.from.y;
    for (let cp of this.followers) {
      cp.x += offsetX;
      cp.y += offsetY;
    }

    this.main.setXY(this.to);
  }

  undo() {
    const offsetX = this.from.x - this.to.x;
    const offsetY = this.from.y - this.to.y;
    for (let cp of this.followers) {
      cp.x += offsetX;
      cp.y += offsetY;
    }

    this.main.setXY(this.from);
  }

  redo() {
    this.execute();
  }

  merge(command: DragControls): boolean {
    // check if followers are the same
    if (this.followers.length !== command.followers.length) return false;

    for (let i = 0; i < this.followers.length; i++) {
      if (this.followers[i] !== command.followers[i]) return false;
    }

    // check if main is the same
    if (this.main !== command.main) return false;

    this.to = command.to;

    return true;
  }

  get updatedItems(): readonly PathTreeItem[] {
    return [this.main, ...this.followers];
  }
}

export class AddKeyframe implements CancellableCommand {
  constructor(public keyframes: KeyframeList<Keyframe>, public keyframe: Keyframe) {}

  execute(): void {
    this.keyframes.add(this.keyframe);
  }

  undo(): void {
    this.keyframes.remove(this.keyframe);
  }

  redo(): void {
    this.execute();
  }
}

export class MoveKeyframe implements CancellableCommand, MergeableCommand {
  protected _oldPos?: KeyframePos;

  constructor(
    public segments: Segment[],
    public key: SegmentKeyframeKey,
    public newPos: KeyframePos,
    public keyframe: Keyframe
  ) {}

  protected removeKeyframe(pos: KeyframePos) {
    pos.segment[this.key].remove(this.keyframe);
  }

  protected addKeyframe(pos: KeyframePos) {
    this.keyframe.xPos = pos.xPos;
    this.keyframe.yPos = pos.yPos;
    pos.segment[this.key].add(this.keyframe);
  }

  execute(): void {
    // ALGO: Remove keyframe from oldSegment speed control
    for (const segment of this.segments) {
      if (segment[this.key].remove(this.keyframe)) {
        this._oldPos = { segment, xPos: this.keyframe.xPos, yPos: this.keyframe.yPos };
        break;
      }
    }
    this.addKeyframe(this.newPos);
  }

  undo(): void {
    if (!this._oldPos) return;

    this.removeKeyframe(this.newPos);
    this.addKeyframe(this._oldPos);
  }

  redo(): void {
    if (!this._oldPos) return;

    this.removeKeyframe(this._oldPos);
    this.addKeyframe(this.newPos);
  }

  merge(command: MoveKeyframe) {
    if (command.keyframe !== this.keyframe) return false;

    this.newPos = command.newPos;

    return true;
  }

  get oldPos() {
    return this._oldPos;
  }
}

export class RemoveKeyframe implements CancellableCommand {
  protected _segment?: Segment;
  protected _oldIdx = -1;

  constructor(public segments: Segment[], public key: SegmentKeyframeKey, public keyframe: Keyframe) {}

  execute(): void {
    for (const segment of this.segments) {
      if (segment[this.key].remove(this.keyframe)) {
        this._segment = segment;
        break;
      }
    }
  }

  undo(): void {
    if (this._segment === undefined) return;

    this._segment[this.key].add(this.keyframe);
  }

  redo(): void {
    if (this._segment === undefined) return;

    this._segment[this.key].remove(this.keyframe);
  }

  get segment() {
    return this._segment;
  }

  get oldIdx() {
    return this._oldIdx;
  }
}

export class RemovePathsAndEndControls implements CancellableCommand, RemovePathTreeItemsCommand {
  protected _entities: PathTreeItem[] = [];

  public removalPaths: Path[] = [];
  public removalEndControls: { path: Path; control: EndControl }[] = [];
  protected pathActions: { index: number; path: Path }[] = [];
  protected segmentActions: {
    index: number;
    segment: Segment;
    path: Path;
    linkNeeded: boolean;
  }[] = [];

  /**
   * Remove paths and end controls in the entities list
   *
   * Compared to RemovePathTreeItems, it usually remove all related segments
   *
   * @param paths all paths in the editor
   * @param entities entities to remove
   */
  constructor(public paths: Path[], entities: (string | PathTreeItem)[]) {
    // ALGO: Create a set of all entity uids
    const allEntities = new Set(entities.map(e => (typeof e === "string" ? e : e.uid)));

    // ALGO: Loop through all paths, add the path and end controls to the removal list if they are in the entity list
    for (const path of paths) {
      if (allEntities.delete(path.uid)) {
        this.removalPaths.push(path);
      } else {
        // ALGO: Only add the end control if the path is not already in the removal list
        for (const control of path.controls) {
          if (control instanceof EndControl && allEntities.delete(control.uid)) {
            this.removalEndControls.push({ path, control });
          }
        }
      }
    }
  }

  protected removePath(path: Path): boolean {
    const idx = this.paths.indexOf(path);

    this.paths.splice(idx, 1);
    this.pathActions.push({ index: idx, path });
    this._entities.push(path, ...path.controls);
    return true;
  }

  protected removeControl(request: { path: Path; control: EndControl }): boolean {
    const { path, control } = request;
    for (let index = 0; index < path.segments.length; index++) {
      const segment = path.segments[index];

      const isFirstControlOfSegment = segment.first === control; // pointer comparison
      const isLastSegment = index + 1 === path.segments.length;
      const isLastControlOfLastSegment = isLastSegment && segment.last === control; // pointer comparison

      if ((isFirstControlOfSegment || isLastControlOfLastSegment) === false) continue;

      const isFirstSegment = index === 0;
      const isOnlySegment = path.segments.length === 1;
      const linkNeeded = isFirstControlOfSegment && isFirstSegment === false;

      if (linkNeeded) {
        const prev = path.segments[index - 1];
        prev.last = segment.last; // pointer assignment
      }

      // ALGO: Remove the segment at index i of the path segment list
      path.segments.splice(index, 1);
      this.segmentActions.push({ index, segment, path, linkNeeded });

      if (isOnlySegment) {
        // ALGO: Define that all controls for the segment disappear
        this._entities.push(...segment.controls);
      } else if (isFirstControlOfSegment) {
        // ALGO: Define that all controls for the segment disappear except for the last one
        this._entities.push(...segment.controls.slice(0, -1));
      } else {
        // ALGO: Define that all controls for the segment disappear except for the first one
        this._entities.push(...segment.controls.slice(1)); // keep the first control
      }
      return true;
    }

    return false;
  }

  execute(): boolean {
    if (this.hasTargets === false) return false;
    this.removalPaths.forEach(this.removePath.bind(this));
    this.removalEndControls.forEach(this.removeControl.bind(this));
    return true;
  }

  undo(): void {
    for (let i = this.pathActions.length - 1; i >= 0; i--) {
      const { index, path } = this.pathActions[i];
      this.paths.splice(index, 0, path);
    }

    for (let i = this.segmentActions.length - 1; i >= 0; i--) {
      const { index, segment, path, linkNeeded } = this.segmentActions[i];
      path.segments.splice(index, 0, segment);

      if (linkNeeded) {
        const prev = path.segments[index - 1];
        prev.last = segment.first; // pointer assignment
      }
    }
  }

  redo(): void {
    for (const { index } of this.pathActions) {
      this.paths.splice(index, 1);
    }

    for (const { index, segment, path, linkNeeded } of this.segmentActions) {
      path.segments.splice(index, 1);

      if (linkNeeded) {
        const prev = path.segments[index - 1];
        prev.last = segment.last; // pointer assignment
      }
    }
  }

  get hasTargets(): boolean {
    return this.removalPaths.length > 0 || this.removalEndControls.length > 0;
  }

  get removedItems(): readonly PathTreeItem[] {
    return this._entities;
  }
}

export class MovePath implements CancellableCommand, UpdatePathTreeItemsCommand {
  protected moving: PathTreeItem[] = [];

  constructor(public paths: Path[], public fromIdx: number, public toIdx: number) {}

  public execute(): boolean {
    if (!this.isValid) return false;

    const path = this.paths.splice(this.fromIdx, 1)[0];
    this.paths.splice(this.toIdx, 0, path);

    this.moving = [path];

    return true;
  }

  public undo(): void {
    if (!this.isValid) return;

    const path = this.paths.splice(this.toIdx, 1)[0];
    this.paths.splice(this.fromIdx, 0, path);
  }

  public redo(): void {
    this.execute();
  }

  get isValid() {
    return this.fromIdx >= 0 && this.fromIdx < this.paths.length && this.toIdx >= 0 && this.toIdx < this.paths.length;
  }

  get updatedItems(): readonly PathTreeItem[] {
    return this.moving;
  }
}

export class MovePathTreeItem implements CancellableCommand, UpdatePathTreeItemsCommand, RemovePathTreeItemsCommand {
  protected removed: PathTreeItem[] = [];
  protected moving: PathTreeItem | undefined;
  protected original: PathStructureMemento[] = [];
  protected modified: PathStructureMemento[] = [];

  constructor(public allEntities: PathTreeItem[], public fromIdx: number, public toIdx: number) {}

  execute(): boolean {
    if (!this.isValid) return false;

    this.original = createStructureMemento(this.allEntities.filter(e => e instanceof Path) as Path[]);

    const temp = this.allEntities.slice();

    this.moving = temp.splice(this.fromIdx, 1)[0];
    temp.splice(this.toIdx, 0, this.moving);

    const removed = construct(temp);
    if (removed === undefined) return false;

    this.removed = removed;

    this.modified = createStructureMemento(this.allEntities.filter(e => e instanceof Path) as Path[]);

    return true;
  }

  undo(): void {
    applyStructureMemento(this.original);
  }

  redo(): void {
    applyStructureMemento(this.modified);
  }

  get isValid() {
    return (
      this.fromIdx >= 0 &&
      this.fromIdx < this.allEntities.length &&
      this.toIdx >= 0 &&
      this.toIdx < this.allEntities.length
    );
  }

  get updatedItems(): readonly PathTreeItem[] {
    return this.moving ? [this.moving] : [];
  }

  get removedItems(): readonly PathTreeItem[] {
    return this.removed;
  }

  get originalStructure(): readonly PathStructureMemento[] {
    return this.original;
  }

  get modifiedStructure(): readonly PathStructureMemento[] {
    return this.modified;
  }
}

export class InsertPaths implements CancellableCommand, AddPathTreeItemsCommand {
  protected added: PathTreeItem[] = [];

  constructor(public paths: Path[], public idx: number, public inserting: Path[]) {}

  execute(): boolean | void {
    if (!this.isValid) return false;

    this.added = traversal(this.inserting);

    this.paths.splice(this.idx, 0, ...this.inserting);
  }

  undo(): void {
    this.paths.splice(this.idx, this.inserting.length);
  }

  redo(): void {
    this.execute();
  }

  get isValid() {
    // ALGO: + 1 to index at the end
    return this.idx >= 0 && this.idx < this.paths.length + 1;
  }

  get addedItems() {
    return this.added;
  }
}

export class InsertControls implements CancellableCommand, AddPathTreeItemsCommand, RemovePathTreeItemsCommand {
  protected removed: PathTreeItem[] = [];
  protected original: PathStructureMemento[] = [];
  protected modified: PathStructureMemento[] = [];

  constructor(public allEntities: PathTreeItem[], public idx: number, public inserting: AnyControl[]) {}

  execute(): boolean {
    if (!this.isValid) return false;

    this.original = createStructureMemento(this.allEntities.filter(e => e instanceof Path) as Path[]);

    const temp = this.allEntities.slice();
    temp.splice(this.idx, 0, ...this.inserting);

    const removed = construct(temp);
    if (removed === undefined) return false;

    this.removed = removed;

    this.modified = createStructureMemento(this.allEntities.filter(e => e instanceof Path) as Path[]);

    return true;
  }

  undo(): void {
    applyStructureMemento(this.original);
  }

  redo(): void {
    applyStructureMemento(this.modified);
  }

  get isValid() {
    return (
      this.idx >= 1 && // ALGO: Index 0 is likely to be invalid
      this.idx < this.allEntities.length + 1 // ALGO: + 1 to index at the end
    );
  }

  get addedItems() {
    return this.inserting;
  }

  get removedItems() {
    return this.removed;
  }

  get originalStructure(): readonly PathStructureMemento[] {
    return this.original;
  }

  get modifiedStructure(): readonly PathStructureMemento[] {
    return this.modified;
  }
}

export class AddPath extends InsertPaths {
  constructor(public paths: Path[], public path: Path) {
    super(paths, paths.length, [path]);
  }
}

export class RemovePathTreeItems implements CancellableCommand, RemovePathTreeItemsCommand {
  protected removed: PathTreeItem[] = [];

  protected original: PathStructureMemento[] = [];
  protected modified: PathStructureMemento[] = [];

  constructor(public paths: Path[], public removal: PathTreeItem[]) {}

  execute(): boolean {
    this.original = createStructureMemento(this.paths);

    const existingPaths = this.paths.filter(p => this.removal.includes(p) === false);
    const temp = traversal(existingPaths).filter(i => this.removal.includes(i) === false);

    const removed = construct(temp);
    if (removed === undefined) return false;

    this.paths.splice(0, this.paths.length, ...existingPaths);
    this.removed = [...removed, ...this.removal];

    this.modified = createStructureMemento(this.paths);

    return this.isValid;
  }

  undo(): void {
    applyStructureMemento(this.original);
    this.paths.splice(0, this.paths.length, ...this.original.map(m => m.path));
  }

  redo(): void {
    applyStructureMemento(this.modified);
    this.paths.splice(0, this.paths.length, ...this.modified.map(m => m.path));
  }

  get isValid() {
    return this.removed.length !== 0;
  }

  get removedItems(): readonly PathTreeItem[] {
    return this.removed;
  }

  get originalStructure(): readonly PathStructureMemento[] {
    return this.original;
  }

  get modifiedStructure(): readonly PathStructureMemento[] {
    return this.modified;
  }
}
