/**
 * cg02 / claude-design / GPT-6 Astra Pro — 2026-10-27
 * Visual/game controller source only. NOT BOUND TO THE AIRCRAFT; NOT TESTED.
 * Owner order: canopy clear -> rear seat clear -> front seat.
 * Source candidate: f18-super-hornet.glb at
 * ea5b8f554f234e90a9243d0ea437edc9a7ec2961,
 * Git blob e776ef9060720db409083d0233e7d3a7c7ca1447.
 * Its binary has NOT been recovered/inspected by this authoring session.
 * No real hardware timing, collision certification, UE5 success or new model
 * revision is represented by this file. F/A-18F and EA-18G need separate,
 * inspected scene bindings. Normal canopy opening is a separate system.
 *
 * Adapter contract (synchronous; no external dependencies):
 * readScene() returns a fresh, monotonically increasing sample:
 * { sampleId: number,
 *   canopy: { present: boolean, detached: boolean, clear: boolean },
 *   rearSeat: { present: boolean, detached: boolean, clear: boolean },
 *   frontSeat: { present: boolean, detached: boolean, clear: boolean } }
 * clear must come from the actual transformed scene clearance predicate:
 * canopy against both exit paths; rear against the front exit path;
 * front against its own exit path. A hidden mesh or completed timer is NOT
 * clearance. present means the persistent object exists, attached or detached.
 *
 * command(action, eventId) returns true only when the scene consumer accepts
 * the command. Valid actions: jettisonCanopy, ejectRearSeat, ejectFrontSeat.
 * Preserve the same seat/crew object IDs and world transforms on detachment.
 * No new seats are spawned by this controller. Commands are issued at most
 * once per eventId. A rejected/uncertain command blocks; no automatic retry.
 *
 * Optional restoreInspectionPose() returns true after explicitly restoring
 * the full inspection scene. Reset is NOT reverse ejection in normal play.
 * This controller does not implement seat/crew separation or parachutes;
 * those require independent, evidence-backed downstream bindings.
 */

export const provenance = Object.freeze({
  owner: 'cg02', revision: 'escape-sequence-r0001',
  status: 'SOURCE_ONLY_UNBOUND_UNTESTED',
  sourceCommit: 'ea5b8f554f234e90a9243d0ea437edc9a7ec2961',
  sourceBlob: 'e776ef9060720db409083d0233e7d3a7c7ca1447',
  nativeUnreal: 'NOT_RUN', sceneIntegration: 'NOT_RUN'
});

export class EscapeSequence {
  #adapter; #phase = 'idle'; #id = null; #lastSample = -Infinity;
  #issued = new Set(); #paused = false; #busy = false; #reason = '';
  #events = [];

  constructor(adapter) {
    if (!adapter || typeof adapter.readScene !== 'function' ||
        typeof adapter.command !== 'function') {
      throw new TypeError('An inspected scene adapter is required.');
    }
    this.#adapter = adapter;
  }

  get state() {
    return Object.freeze({ phase: this.#phase, eventId: this.#id,
      paused: this.#paused, reason: this.#reason,
      issued: [...this.#issued], events: this.#events.map(x => ({...x})) });
  }

  #block(reason) {
    this.#phase = 'blocked'; this.#reason = String(reason);
    this.#events.push({phase: 'blocked', reason: this.#reason});
    return this.state;
  }

  #read() {
    const s = this.#adapter.readScene();
    if (!s || !Number.isSafeInteger(s.sampleId) || s.sampleId < 0) {
      throw new Error('Missing valid scene sampleId.');
    }
    for (const role of ['canopy', 'rearSeat', 'frontSeat']) {
      const p = s[role];
      if (!p || p.present !== true || typeof p.detached !== 'boolean' ||
          typeof p.clear !== 'boolean') {
        throw new Error(`Missing persistent object or clearance data: ${role}`);
      }
    }
    return s;
  }

  #issue(action) {
    if (this.#issued.has(action)) return;
    // Record before invoking: an uncertain or re-entrant callback must not
    // cause duplicate detachment/spawning on a subsequent frame.
    this.#issued.add(action);
    if (this.#adapter.command(action, `${this.#id}:${action}`) !== true) {
      throw new Error(`Scene did not confirm command acceptance: ${action}`);
    }
    this.#events.push({action, eventId: `${this.#id}:${action}`});
  }

  start(eventId) {
    if (this.#busy) return this.state;
    if (typeof eventId !== 'string' || !eventId.trim()) {
      throw new TypeError('A stable, nonempty eventId is required.');
    }
    if (this.#id === eventId) return this.state;
    if (this.#phase !== 'idle') {
      throw new Error('Sequence already consumed/blocked; explicit inspection reset required.');
    }
    this.#busy = true; this.#id = eventId;
    try {
      const s = this.#read();
      if (s.rearSeat.detached || s.frontSeat.detached) {
        throw new Error('Both seats must start attached for this two-seat sequence.');
      }
      this.#lastSample = s.sampleId;
      this.#phase = 'waiting_canopy_clear';
      if (!s.canopy.detached) this.#issue('jettisonCanopy');
      // Even an already detached canopy needs a fresh clearance sample.
    } catch (e) { this.#block(e instanceof Error ? e.message : e); }
    finally { this.#busy = false; }
    return this.state;
  }

  update() {
    if (this.#busy || this.#paused ||
        ['idle', 'blocked', 'seat_launches_complete'].includes(this.#phase)) {
      return this.state;
    }
    this.#busy = true;
    try {
      const s = this.#read();
      if (s.sampleId <= this.#lastSample) return this.state;
      this.#lastSample = s.sampleId;
      const canopyClear = s.canopy.detached && s.canopy.clear;
      // One transition per fresh sample; never fire both seats in one update.
      if (this.#phase === 'waiting_canopy_clear') {
        if (canopyClear) {
          this.#issue('ejectRearSeat');
          this.#phase = 'waiting_rear_clear';
        }
      } else if (this.#phase === 'waiting_rear_clear') {
        if (canopyClear && s.rearSeat.detached && s.rearSeat.clear) {
          this.#issue('ejectFrontSeat');
          this.#phase = 'waiting_front_clear';
        }
      } else if (this.#phase === 'waiting_front_clear') {
        if (s.frontSeat.detached && s.frontSeat.clear) {
          this.#phase = 'seat_launches_complete';
          this.#events.push({phase: this.#phase});
        }
      }
    } catch (e) { this.#block(e instanceof Error ? e.message : e); }
    finally { this.#busy = false; }
    return this.state;
  }

  setPaused(value) {
    // Pauses scheduling only. The inspector must separately pause its scene.
    if (typeof value !== 'boolean') throw new TypeError('Expected boolean.');
    this.#paused = value;
    return this.state;
  }

  resetForInspection() {
    if (this.#busy) return this.state;
    this.#busy = true;
    try {
      if (typeof this.#adapter.restoreInspectionPose !== 'function' ||
          this.#adapter.restoreInspectionPose() !== true) {
        throw new Error('Full inspection-scene restoration was not confirmed.');
      }
      const s = this.#read();
      if (s.canopy.detached || s.rearSeat.detached || s.frontSeat.detached) {
        throw new Error('Inspection reset left a component detached.');
      }
      this.#phase = 'idle'; this.#id = null; this.#lastSample = s.sampleId;
      this.#issued.clear(); this.#paused = false; this.#reason = '';
      this.#events = [];
    } catch (e) { this.#block(e instanceof Error ? e.message : e); }
    finally { this.#busy = false; }
    return this.state;
  }
}
