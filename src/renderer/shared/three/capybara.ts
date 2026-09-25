/**
 * The placeholder capybara — built from three.js primitives, no asset needed.
 *
 * Deliberately crude, like the 2D blob before it: a capsule barrel, a boxy
 * head with a blunt snout, four stubby legs, two ears. Its job is to prove
 * the pose path end to end so the rig can be felt before a real model exists.
 *
 * It is a proper little hierarchy rather than one mesh, because every pose
 * param maps onto a joint: legs fold for `crouch`, the neck pivots for
 * `headPitch`, ears hinge for `earDroop`, eyelids scale for `eyeOpen`. A
 * rigged glTF would expose the same joints as bones.
 */

import * as THREE from 'three';
import type { PoseName, PoseParams } from '../../../core/pose.js';
import { applySaturation, disposeTree, type AvatarModel3D } from './model.js';

const FUR = 0x9a6a3f;
const FUR_DARK = 0x6e4a2b;
const NOSE = 0x2a1d14;
const EYE = 0x140e0a;

/** Leg length below the belly, in world units. */
const LEG = 0.14;
const BODY_R = 0.26;
/** Body height used to scale bob and hop amplitudes. */
const HEIGHT = LEG + BODY_R * 2;

export class PrimitiveCapybara implements AvatarModel3D {
  readonly root = new THREE.Group();
  readonly detail = 'primitive';

  /** Named joints, exposed for tests and for anyone tuning the rig. */
  readonly joints: {
    body: THREE.Group;
    torso: THREE.Mesh;
    neck: THREE.Group;
    legs: THREE.Group[];
    ears: THREE.Group[];
    eyes: THREE.Mesh[];
  };

  private bobPhase = 0;
  private swayPhase = 0;
  private hopPhase = 0;
  private breathPhase = 0;
  private lastSaturation = -1;

  constructor() {
    this.root.name = 'capybara';
    const fur = new THREE.MeshStandardMaterial({ color: FUR, roughness: 0.92 });
    const dark = new THREE.MeshStandardMaterial({ color: FUR_DARK, roughness: 0.95 });
    const nose = new THREE.MeshStandardMaterial({ color: NOSE, roughness: 0.6 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: EYE, roughness: 0.3 });

    // Body pivots at ground level so crouch/curl rotate about the belly, not the air.
    const body = new THREE.Group();
    body.name = 'body';
    this.root.add(body);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(BODY_R, 0.5, 8, 20), fur);
    torso.name = 'torso';
    torso.rotation.z = Math.PI / 2; // lie the capsule along +x
    torso.position.y = LEG + BODY_R;
    body.add(torso);

    const legs: THREE.Group[] = [];
    for (const [x, z] of [
      [0.26, 0.14],
      [0.26, -0.14],
      [-0.26, 0.14],
      [-0.26, -0.14],
    ] as const) {
      const hip = new THREE.Group();
      hip.name = 'leg';
      hip.position.set(x, LEG + 0.06, z);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, LEG + 0.06, 10), dark);
      leg.position.y = -(LEG + 0.06) / 2; // hang from the hip so scaling folds it upward
      hip.add(leg);
      body.add(hip);
      legs.push(hip);
    }

    // Neck pivot sits at the top-front of the barrel; the head hangs forward of it.
    const neck = new THREE.Group();
    neck.name = 'neck';
    neck.position.set(0.4, LEG + BODY_R * 1.55, 0);
    body.add(neck);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.26, 2, 2, 2), fur);
    head.name = 'head';
    head.position.set(0.14, 0, 0);
    neck.add(head);

    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.21), dark);
    snout.name = 'snout';
    snout.position.set(0.33, -0.03, 0);
    neck.add(snout);

    for (const z of [0.045, -0.045]) {
      const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), nose);
      nostril.position.set(0.405, 0.02, z);
      neck.add(nostril);
    }

    const eyes: THREE.Mesh[] = [];
    for (const z of [0.132, -0.132]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), eyeMat);
      eye.name = 'eye';
      eye.position.set(0.19, 0.06, z);
      neck.add(eye);
      eyes.push(eye);
    }

    const ears: THREE.Group[] = [];
    for (const side of [1, -1]) {
      const hinge = new THREE.Group();
      hinge.name = 'ear';
      hinge.position.set(0.02, 0.12, 0.1 * side);
      hinge.userData.side = side;
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), dark);
      ear.scale.set(0.7, 1, 0.45);
      ear.position.y = 0.035;
      hinge.add(ear);
      neck.add(hinge);
      ears.push(hinge);
    }

    this.joints = { body, torso, neck, legs, ears, eyes };
  }

  /** The primitive rig has no clips; the params carry the whole pose. */
  setPose(_pose: PoseName): void {}

  update(p: PoseParams, timeS: number, dtS: number): void {
    const { body, torso, neck, legs, ears, eyes } = this.joints;
    const tau = Math.PI * 2;

    // Phases accumulate rather than being sin(t·hz): a rate that eases between
    // poses would otherwise jump phase and make the body twitch mid-blend.
    this.bobPhase = (this.bobPhase + dtS * p.bobHz * tau) % tau;
    this.swayPhase = (this.swayPhase + dtS * 1.3 * tau) % tau;
    this.hopPhase = (this.hopPhase + dtS * 2.2 * tau) % tau;
    this.breathPhase = (this.breathPhase + dtS * 0.3 * tau) % tau;

    // Whole-body rhythm: bob, celebrate hop, sway.
    const bob = Math.sin(this.bobPhase) * p.bobAmp * HEIGHT;
    const hop = Math.abs(Math.sin(this.hopPhase)) * p.hop * HEIGHT;
    this.root.position.y = bob + hop;
    this.root.rotation.y = Math.sin(this.swayPhase) * p.sway;

    // Crouch: legs fold into the belly and the body sinks to the floor.
    const legScale = Math.max(0.08, 1 - p.crouch * 0.92);
    for (const leg of legs) leg.scale.y = legScale;
    body.position.y = -(1 - legScale) * (LEG + 0.02);

    // Girth from nourishment, squash from crouch, rise and fall from breath.
    const breath = Math.sin(this.breathPhase) * p.breathe;
    body.scale.set(1 + (p.plump - 1) * 0.5, p.plump * (1 - p.crouch * 0.08), p.plump);
    torso.scale.set(1 + breath, 1, 1 + breath); // capsule is rotated: local x is world y

    // Sleep curl: roll a little onto the side, tuck the head toward the body.
    body.rotation.x = p.curl * 0.55;
    neck.rotation.y = p.curl * 0.9;
    neck.rotation.z = -p.headPitch; // positive pitch tips the nose (+x) down

    for (const ear of ears) {
      ear.rotation.x = (ear.userData.side as number) * p.earDroop * 1.1;
    }

    // Eyelids, plus a blink every few seconds while awake.
    const blinking = p.eyeOpen > 0.3 && timeS % 4.2 < 0.12;
    const open = blinking ? 0.1 : Math.max(0.08, p.eyeOpen);
    for (const eye of eyes) eye.scale.y = open;

    // Saturation only changes on state/energy moves; skip the material walk otherwise.
    if (Math.abs(p.saturation - this.lastSaturation) > 0.004) {
      applySaturation(this.root, p.saturation);
      this.lastSaturation = p.saturation;
    }
  }

  dispose(): void {
    disposeTree(this.root);
  }
}
