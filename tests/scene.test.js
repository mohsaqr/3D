import test from "node:test";
import assert from "node:assert/strict";

import * as THREE from "three";

import {
  aimBoneAtWorldDirection,
  attachBodyRegions,
  configurePatientAvatar,
  createBed,
  createClinicalRoom,
  createMonitor,
  createOxygenStation,
  createPatient,
  findAvatarBone,
  findInteractiveData,
  loadPatientAvatar,
  setColliderMark,
  poseAvatarInBed,
  tagInteractive,
  updateClinicalScene,
  updateRiggedPatient,
} from "../src/scene.js";

function directChildrenNamed(object, name) {
  return object.children.filter((child) => child.name === name);
}

function assertVectorClose(actual, expected, tolerance = 1e-10) {
  assert.ok(
    actual.distanceTo(expected) <= tolerance,
    `expected ${actual.toArray()} to be within ${tolerance} of ${expected.toArray()}`,
  );
}

function assertQuaternionClose(actual, expected, tolerance = 1e-7) {
  assert.ok(
    actual.angleTo(expected) <= tolerance,
    `expected quaternion angle difference ${actual.angleTo(expected)} to be <= ${tolerance}`,
  );
}

function assertColorClose(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual.r - expected.r) <= tolerance);
  assert.ok(Math.abs(actual.g - expected.g) <= tolerance);
  assert.ok(Math.abs(actual.b - expected.b) <= tolerance);
}

function worldSegmentDirection(bone, child) {
  bone.parent?.updateWorldMatrix(true, true);
  const bone_position = new THREE.Vector3();
  const child_position = new THREE.Vector3();
  bone.getWorldPosition(bone_position);
  child.getWorldPosition(child_position);
  return child_position.sub(bone_position).normalize();
}

function addArm(root, names, side) {
  const shoulder = new THREE.Bone();
  shoulder.name = names.shoulder;
  shoulder.position.set(side * 0.22, 0.55, 0);

  const upper = new THREE.Bone();
  upper.name = names.upper;
  upper.position.set(side * 0.18, 0, 0);

  const forearm = new THREE.Bone();
  forearm.name = names.forearm;
  forearm.position.set(side * 0.46, 0, 0);

  const hand = new THREE.Bone();
  hand.name = names.hand;
  hand.position.set(side * 0.38, 0, 0);

  root.add(shoulder);
  shoulder.add(upper);
  upper.add(forearm);
  forearm.add(hand);
  return { shoulder, upper, forearm, hand };
}

function createSyntheticAvatar({ rig_family = "standard" } = {}) {
  const model = new THREE.Group();
  model.name = "synthetic-avatar-source";

  const hips = new THREE.Bone();
  hips.name = rig_family === "rocketbox" ? "Bip01 Pelvis" : "Hips";
  hips.position.set(0, 0.2, 0);

  const spine = new THREE.Bone();
  spine.name = rig_family === "rocketbox" ? "Bip01 Spine2" : "Spine2";
  spine.position.set(0, 0.72, 0);

  const head = new THREE.Bone();
  head.name = rig_family === "rocketbox" ? "Bip01 Head" : "Head";
  head.position.set(0, 0.72, 0);

  hips.add(spine);
  spine.add(head);
  const left_names = rig_family === "rocketbox"
    ? {
        shoulder: "Bip01 L Clavicle",
        upper: "Bip01 L UpperArm",
        forearm: "Bip01 L Forearm",
        hand: "Bip01 L Hand",
      }
    : {
        shoulder: "LeftShoulder",
        upper: "LeftArm",
        forearm: "LeftForeArm",
        hand: "LeftHand",
      };
  const right_names = rig_family === "rocketbox"
    ? {
        shoulder: "Bip01 R Clavicle",
        upper: "Bip01 R UpperArm",
        forearm: "Bip01 R Forearm",
        hand: "Bip01 R Hand",
      }
    : {
        shoulder: "RightShoulder",
        upper: "RightArm",
        forearm: "RightForeArm",
        hand: "RightHand",
      };
  const left_arm = addArm(spine, left_names, 1);
  const right_arm = addArm(spine, right_names, -1);
  model.add(hips);

  const head_material = new THREE.MeshStandardMaterial({
    color: 0x9f684e,
    emissive: 0x120705,
    emissiveIntensity: 0.025,
  });
  const head_mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), head_material);
  head_mesh.name = "AvatarHead";
  head_mesh.morphTargetDictionary = {
    eyeBlinkLeft: 0,
    eyeBlinkRight: 1,
    eyesClosed: 2,
    jawOpen: 3,
    mouthOpen: 4,
    viseme_O: 5,
  };
  head_mesh.morphTargetInfluences = [0, 0, 0, 0, 0, 0];

  const body_materials = [
    new THREE.MeshStandardMaterial({ color: 0x8d573f }),
    new THREE.MeshStandardMaterial({ color: 0xb87a5e }),
  ];
  const body_mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.25), body_materials);
  body_mesh.name = "avatarBody_LOD0";

  const clothing_material = new THREE.MeshStandardMaterial({ color: 0x24606a });
  const clothing_mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.52, 0.82, 0.27),
    clothing_material,
  );
  clothing_mesh.name = "HospitalGown";
  model.add(head_mesh, body_mesh, clothing_mesh);

  return {
    model,
    hips,
    spine,
    head,
    left_arm,
    right_arm,
    head_mesh,
    body_mesh,
    clothing_mesh,
    original_materials: {
      head: head_material,
      body: body_materials,
      clothing: clothing_material,
    },
  };
}

function createSyntheticAnimationRig() {
  const spine = new THREE.Bone();
  spine.scale.set(1.2, 0.9, 1.1);
  const head = new THREE.Bone();
  head.quaternion.setFromEuler(new THREE.Euler(0.08, -0.04, 0.02));
  const left_shoulder = new THREE.Bone();
  left_shoulder.quaternion.setFromEuler(new THREE.Euler(0.02, 0.03, -0.01));
  const right_shoulder = new THREE.Bone();
  right_shoulder.quaternion.setFromEuler(new THREE.Euler(-0.02, -0.03, 0.01));

  const morph_mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  morph_mesh.morphTargetDictionary = {
    eyeBlinkLeft: 0,
    eyeBlinkRight: 1,
    eyesClosed: 2,
    jawOpen: 3,
    mouthOpen: 4,
    viseme_O: 5,
  };
  morph_mesh.morphTargetInfluences = [0, 0, 0, 0, 0, 0];

  const skin_material = new THREE.MeshStandardMaterial({
    color: 0x9f684e,
    emissive: 0x120705,
    emissiveIntensity: 0.025,
  });
  return {
    spine,
    spine_rest_scale: spine.scale.clone(),
    head,
    head_rest_quaternion: head.quaternion.clone(),
    left_shoulder,
    left_shoulder_rest_quaternion: left_shoulder.quaternion.clone(),
    right_shoulder,
    right_shoulder_rest_quaternion: right_shoulder.quaternion.clone(),
    morph_targets: [morph_mesh],
    skin_materials: [{
      material: skin_material,
      base_color: skin_material.color.clone(),
      base_emissive: skin_material.emissive.clone(),
      base_emissive_intensity: skin_material.emissiveIntensity,
    }],
  };
}

test("createClinicalRoom composes the complete named clinical room", () => {
  const room = createClinicalRoom();
  const expected_names = [
    "floor",
    "back-wall",
    "left-wall",
    "ceiling",
    "headwall-accent",
    "skirting",
    "skirting",
    "room-window",
    "patient-bed",
    "patient-bed-cover",
    "vital-sign-monitor",
    "oxygen-station",
    "iv-pole",
    "bedside-cabinet",
    "exam-lamp",
    "privacy-curtain",
    "wall-details",
  ];

  assert.ok(room instanceof THREE.Group);
  assert.equal(room.name, "clinical-room");
  assert.deepEqual(
    room.children.map((child) => child.name),
    expected_names,
  );
  expected_names.forEach((name) => {
    assert.ok(room.getObjectByName(name) instanceof THREE.Object3D, `${name} is present`);
  });
  assert.equal(room.getObjectByName("floor").receiveShadow, true);
  assert.equal(room.getObjectByName("floor-grid"), undefined, "the stylized floor grid is gone");
  assert.ok(room.getObjectByName("ceiling") instanceof THREE.Mesh);
  assert.ok(room.getObjectByName("room-door") instanceof THREE.Object3D);
  assert.ok(room.getObjectByName("wall-clock") instanceof THREE.Object3D);
  assert.ok(room.getObjectByName("whiteboard") instanceof THREE.Object3D);
  assert.ok(room.getObjectByName("chart-clipboard") instanceof THREE.Mesh);
  assert.ok(room.getObjectByName("ceiling-light-panel") instanceof THREE.Mesh);
  const blanket = room.getObjectByName("patient-blanket");
  const blanket_depths = Array.from(blanket.geometry.attributes.position.array)
    .filter((value, index) => index % 3 === 2);
  assert.ok(blanket instanceof THREE.Mesh);
  assert.ok(Math.max(...blanket_depths) - Math.min(...blanket_depths) > 0.2);
});

test("createBed builds rails, supports, wheels, and an interactive bed", () => {
  const bed = createBed();

  assert.ok(bed instanceof THREE.Group);
  assert.equal(bed.name, "patient-bed");
  assert.deepEqual(bed.userData.interactive, {
    id: "bed",
    label: "Adjust patient position",
  });
  assert.equal(directChildrenNamed(bed, "bed-rail").length, 2);
  assert.equal(directChildrenNamed(bed, "bed-leg").length, 4);
  assert.equal(directChildrenNamed(bed, "bed-wheel").length, 4);
  assert.ok(bed.getObjectByName("bed-frame") instanceof THREE.Mesh);
  assert.ok(bed.getObjectByName("mattress") instanceof THREE.Mesh);
  assert.ok(bed.getObjectByName("headboard") instanceof THREE.Mesh);
  assert.ok(bed.getObjectByName("footboard") instanceof THREE.Mesh);
  assert.ok(bed.getObjectByName("pillow") instanceof THREE.Mesh);
  directChildrenNamed(bed, "bed-rail").forEach((rail) => {
    assert.equal(directChildrenNamed(rail, "rail-post").length, 4);
    assert.ok(rail.getObjectByName("rail-top") instanceof THREE.Mesh);
  });
});

test("createPatient builds the complete procedural fallback with stable animation references", () => {
  const patient = createPatient();
  const { parts } = patient.userData;

  assert.ok(patient instanceof THREE.Group);
  assert.equal(patient.name, "patient-avatar");
  assert.deepEqual(patient.userData.interactive, {
    id: "patient",
    label: "Assess Daniel Moreau",
  });
  assert.deepEqual(Object.keys(parts), [
    "torso",
    "chest_panel",
    "head",
    "eyes",
    "mouth",
    "skin_material",
    "skin_light_material",
  ]);
  assert.strictEqual(parts.torso, patient.getObjectByName("patient-torso"));
  assert.strictEqual(parts.chest_panel, patient.getObjectByName("patient-gown-panel"));
  assert.strictEqual(parts.head, patient.getObjectByName("patient-head"));
  assert.strictEqual(parts.eyes, patient.getObjectByName("patient-eyes"));
  assert.strictEqual(parts.mouth, patient.getObjectByName("patient-mouth"));
  assert.ok(parts.skin_material instanceof THREE.MeshStandardMaterial);
  assert.ok(parts.skin_light_material instanceof THREE.MeshStandardMaterial);
  assert.notStrictEqual(parts.skin_material, parts.skin_light_material);
  assert.equal(directChildrenNamed(patient, "patient-arm").length, 2);
  assert.equal(directChildrenNamed(patient, "patient-hand").length, 2);
  assert.equal(directChildrenNamed(patient, "patient-foot").length, 2);
  assert.equal(parts.eyes.children.length, 4);
});

test("configurePatientAvatar normalizes a full-body avatar and records its animation rig", () => {
  const synthetic = createSyntheticAvatar();
  const patient = configurePatientAvatar(synthetic.model);
  const { avatar_rig: rig } = patient.userData;

  assert.ok(patient instanceof THREE.Group);
  assert.equal(patient.name, "patient-avatar");
  assert.strictEqual(patient.getObjectByName("patient-avatar-model"), synthetic.model);
  assertVectorClose(synthetic.model.scale, new THREE.Vector3(1.72, 1.72, 1.72));
  assertVectorClose(synthetic.model.position, new THREE.Vector3(0, 1.32, 1.43));
  assert.ok(Math.abs(synthetic.model.rotation.x + Math.PI / 2) < 1e-12);
  assert.deepEqual(patient.userData.interactive, {
    id: "patient",
    label: "Assess Daniel Moreau",
  });
  assert.equal(patient.userData.avatar_source, "Rohy AvatarSDK full-body GLB");

  [synthetic.head_mesh, synthetic.body_mesh, synthetic.clothing_mesh].forEach((mesh) => {
    assert.equal(mesh.castShadow, true);
    assert.equal(mesh.receiveShadow, true);
    assert.equal(mesh.frustumCulled, false);
  });
  assert.notStrictEqual(synthetic.head_mesh.material, synthetic.original_materials.head);
  assert.notStrictEqual(synthetic.clothing_mesh.material, synthetic.original_materials.clothing);
  assert.notStrictEqual(synthetic.body_mesh.material, synthetic.original_materials.body);
  synthetic.body_mesh.material.forEach((material, index) => {
    assert.notStrictEqual(material, synthetic.original_materials.body[index]);
  });

  assert.strictEqual(rig.model, synthetic.model);
  assert.strictEqual(rig.spine, synthetic.spine);
  assert.strictEqual(rig.head, synthetic.head);
  assert.strictEqual(rig.left_shoulder, synthetic.left_arm.shoulder);
  assert.strictEqual(rig.right_shoulder, synthetic.right_arm.shoulder);
  assert.deepEqual(rig.morph_targets, [synthetic.head_mesh]);
  assert.equal(rig.skin_materials.length, 3);
  assertVectorClose(rig.spine_rest_scale, synthetic.spine.scale);
  assertQuaternionClose(rig.head_rest_quaternion, synthetic.head.quaternion);
  assertQuaternionClose(
    rig.left_shoulder_rest_quaternion,
    synthetic.left_arm.shoulder.quaternion,
  );
  assertQuaternionClose(
    rig.right_shoulder_rest_quaternion,
    synthetic.right_arm.shoulder.quaternion,
  );
  rig.skin_materials.forEach(({ material, base_color, base_emissive }) => {
    assert.notStrictEqual(base_color, material.color);
    assertColorClose(base_color, material.color);
    assert.notStrictEqual(base_emissive, material.emissive);
    assertColorClose(base_emissive, material.emissive);
  });
});

test("configurePatientAvatar tolerates models without optional bones, morphs, or materials", () => {
  const model = new THREE.Group();
  const materialless_mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  materialless_mesh.name = "prop";
  materialless_mesh.material = undefined;
  model.add(materialless_mesh);

  const patient = configurePatientAvatar(model);
  const rig = patient.userData.avatar_rig;

  assert.equal(rig.spine, null);
  assert.equal(rig.head, null);
  assert.equal(rig.left_shoulder, null);
  assert.equal(rig.right_shoulder, null);
  assert.equal(rig.spine_rest_scale, null);
  assert.equal(rig.head_rest_quaternion, null);
  assert.deepEqual(rig.morph_targets, []);
  assert.deepEqual(rig.skin_materials, []);
  assert.doesNotThrow(() => {
    updateRiggedPatient(rig, "stable", { respiratory_rate: 16 }, 2);
  });
});

test("configurePatientAvatar rejects values that are not Three.js objects", () => {
  [null, {}, [], "avatar"].forEach((model) => {
    assert.throws(
      () => configurePatientAvatar(model),
      /model must be a THREE\.Object3D/,
    );
  });
});

test("findAvatarBone matches sanitized names and ignores matching non-bone objects", () => {
  const root = new THREE.Group();
  const non_bone = new THREE.Group();
  non_bone.name = "Bip01 L UpperArm";
  const bone = new THREE.Bone();
  bone.name = "Bip01 L UpperArm";
  const other_bone = new THREE.Bone();
  other_bone.name = "Head";
  root.add(non_bone, bone, other_bone);

  assert.strictEqual(findAvatarBone(root, ["bip01_l-upper arm"]), bone);
  assert.strictEqual(findAvatarBone(root, ["HEAD"]), other_bone);
  assert.equal(findAvatarBone(root, ["LeftHand"]), null);
  assert.equal(findAvatarBone(root, []), null);
});

test("findAvatarBone validates the root and candidate-name collection", () => {
  [null, {}, "root"].forEach((root) => {
    assert.throws(
      () => findAvatarBone(root, ["Head"]),
      /root must be a THREE\.Object3D/,
    );
  });
  [null, "Head", {}, ["Head", 2]].forEach((candidate_names) => {
    assert.throws(
      () => findAvatarBone(new THREE.Group(), candidate_names),
      /candidate_names must be an array of strings/,
    );
  });
});

test("aimBoneAtWorldDirection aims through a transformed parent without mutating the target", () => {
  const root = new THREE.Group();
  root.position.set(1.2, -0.4, 0.8);
  root.scale.set(1.4, 1.4, 1.4);
  root.rotation.set(0.25, -0.45, 0.18);
  const bone = new THREE.Bone();
  bone.position.set(0.3, 0.5, -0.2);
  const child = new THREE.Bone();
  child.position.set(0, 0.7, 0);
  root.add(bone);
  bone.add(child);
  root.updateMatrixWorld(true);
  const desired_direction = new THREE.Vector3(1, 2, -0.5);
  const original_target = desired_direction.clone();

  const returned = aimBoneAtWorldDirection(bone, child, desired_direction);

  assert.strictEqual(returned, bone);
  assertVectorClose(desired_direction, original_target);
  assertVectorClose(
    worldSegmentDirection(bone, child),
    desired_direction.clone().normalize(),
  );
});

test("aimBoneAtWorldDirection rejects invalid joints and directions", () => {
  const bone = new THREE.Bone();
  const child = new THREE.Bone();
  [
    [new THREE.Group(), child],
    [bone, new THREE.Group()],
    [null, child],
  ].forEach(([invalid_bone, invalid_child]) => {
    assert.throws(
      () => aimBoneAtWorldDirection(invalid_bone, invalid_child, new THREE.Vector3(1, 0, 0)),
      /bone and child must be THREE\.Bone instances/,
    );
  });
  [new THREE.Vector3(0, 0, 0), null, { x: 1, y: 0, z: 0 }].forEach((direction) => {
    assert.throws(
      () => aimBoneAtWorldDirection(bone, child, direction),
      /desired_direction must be a non-zero THREE\.Vector3/,
    );
  });
});

test("poseAvatarInBed supports standard and RocketBox arm naming conventions", () => {
  ["standard", "rocketbox"].forEach((rig_family) => {
    const synthetic = createSyntheticAvatar({ rig_family });
    const patient = new THREE.Group();
    patient.name = "patient-avatar";
    synthetic.model.name = "patient-avatar-model";
    patient.add(synthetic.model);

    const returned = poseAvatarInBed(patient);

    assert.strictEqual(returned, patient);
    assertVectorClose(
      worldSegmentDirection(synthetic.left_arm.upper, synthetic.left_arm.forearm),
      new THREE.Vector3(0.1, -0.03, 1).normalize(),
    );
    assertVectorClose(
      worldSegmentDirection(synthetic.left_arm.forearm, synthetic.left_arm.hand),
      new THREE.Vector3(0.035, 0.015, 1).normalize(),
    );
    assertVectorClose(
      worldSegmentDirection(synthetic.right_arm.upper, synthetic.right_arm.forearm),
      new THREE.Vector3(-0.1, -0.03, 1).normalize(),
    );
    assertVectorClose(
      worldSegmentDirection(synthetic.right_arm.forearm, synthetic.right_arm.hand),
      new THREE.Vector3(-0.035, 0.015, 1).normalize(),
    );
  });
});

test("poseAvatarInBed uses the supplied object as the model and tolerates incomplete arms", () => {
  const model = new THREE.Group();
  const left_upper = new THREE.Bone();
  left_upper.name = "LeftArm";
  model.add(left_upper);

  assert.strictEqual(poseAvatarInBed(model), model);
  assert.throws(
    () => poseAvatarInBed(null),
    /patient must be a THREE\.Object3D/,
  );
  assert.throws(
    () => poseAvatarInBed({}),
    /patient must be a THREE\.Object3D/,
  );
});

test("updateRiggedPatient applies status-specific breathing, effort, and complexion", () => {
  const cases = [
    { status: "critical", effort: 1, color: 0xc8d3d0, amount: 0.22, emissive: 0x26191a },
    { status: "unstable", effort: 0.72, color: 0xe0d1c7, amount: 0.12, emissive: 0x211817 },
    { status: "stabilizing", effort: 0.42, color: 0xffffff, amount: 0.035, emissive: 0x101818 },
    { status: "stable", effort: 0.28, color: 0xffffff, amount: 0, emissive: 0x000000 },
  ];

  cases.forEach((clinical_case) => {
    const rig = createSyntheticAnimationRig();
    const base_scale = rig.spine_rest_scale;
    const base_color = rig.skin_materials[0].base_color;
    const base_emissive = rig.skin_materials[0].base_emissive;
    updateRiggedPatient(
      rig,
      clinical_case.status,
      { respiratory_rate: 15 },
      1,
    );

    assertVectorClose(
      rig.spine.scale,
      new THREE.Vector3(
        base_scale.x * (1 + 0.035 * clinical_case.effort),
        base_scale.y,
        base_scale.z * (1 + 0.055 * clinical_case.effort),
      ),
    );
    const expected_head = rig.head_rest_quaternion.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        Math.sin(0.55) * 0.012 * clinical_case.effort,
      ),
    );
    assertQuaternionClose(rig.head.quaternion, expected_head);
    const expected_left_shoulder = rig.left_shoulder_rest_quaternion.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        0.02 * clinical_case.effort,
      ),
    );
    const expected_right_shoulder = rig.right_shoulder_rest_quaternion.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        -0.02 * clinical_case.effort,
      ),
    );
    assertQuaternionClose(rig.left_shoulder.quaternion, expected_left_shoulder);
    assertQuaternionClose(rig.right_shoulder.quaternion, expected_right_shoulder);
    assert.deepEqual(
      rig.morph_targets[0].morphTargetInfluences,
      [0, 0, 0, 0.085 * clinical_case.effort, 0.085 * clinical_case.effort, 0.085 * clinical_case.effort],
    );

    const expected_color = base_color.clone().lerp(
      new THREE.Color(clinical_case.color),
      clinical_case.amount,
    );
    const expected_emissive = base_emissive.clone().lerp(
      new THREE.Color(clinical_case.emissive),
      clinical_case.amount,
    );
    const { material, base_emissive_intensity } = rig.skin_materials[0];
    assertColorClose(material.color, expected_color);
    assertColorClose(material.emissive, expected_emissive);
    assert.equal(
      material.emissiveIntensity,
      Math.max(base_emissive_intensity, clinical_case.amount * 0.28),
    );
  });
});

test("updateRiggedPatient drives all known blink and mouth aliases and restores base skin", () => {
  const rig = createSyntheticAnimationRig();
  const skin = rig.skin_materials[0];
  const base_color = skin.base_color.clone();
  const base_emissive = skin.base_emissive.clone();

  updateRiggedPatient(rig, "unknown", { respiratory_rate: 30 }, 0);
  assert.deepEqual(rig.morph_targets[0].morphTargetInfluences.slice(0, 3), [1, 1, 1]);
  rig.morph_targets[0].morphTargetInfluences.slice(3).forEach((influence) => {
    assert.ok(Math.abs(influence - 0.0098) < 1e-12);
  });
  assertColorClose(
    skin.material.color,
    base_color.clone().lerp(new THREE.Color(0xe0d1c7), 0.12),
  );

  updateRiggedPatient(rig, "stable", { respiratory_rate: 15 }, 1);
  assertColorClose(skin.material.color, base_color);
  assertColorClose(skin.material.emissive, base_emissive);
  assert.equal(skin.material.emissiveIntensity, skin.base_emissive_intensity);
  assert.deepEqual(
    rig.morph_targets[0].morphTargetInfluences.slice(0, 3),
    [0, 0, 0],
  );
});

test("updateRiggedPatient tolerates omitted optional rig channels and validates core inputs", () => {
  assert.doesNotThrow(() => {
    updateRiggedPatient({}, "stable", { respiratory_rate: 18 }, 0);
  });
  [null, undefined, "rig"].forEach((rig) => {
    assert.throws(
      () => updateRiggedPatient(rig, "stable", { respiratory_rate: 18 }, 0),
      /rig must be an object/,
    );
  });
  [null, {}, { respiratory_rate: "18" }, { respiratory_rate: Number.NaN }].forEach(
    (vitals) => {
      assert.throws(
        () => updateRiggedPatient({}, "stable", vitals, 0),
        /vitals\.respiratory_rate must be numeric/,
      );
    },
  );
  ["0", Number.NaN, Number.POSITIVE_INFINITY].forEach((elapsed_seconds) => {
    assert.throws(
      () => updateRiggedPatient({}, "stable", { respiratory_rate: 18 }, elapsed_seconds),
      /elapsed_seconds must be numeric/,
    );
  });
});

test("loadPatientAvatar loads, skeleton-clones, and configures a synthetic GLTF scene", async () => {
  const synthetic = createSyntheticAvatar();
  const requested_urls = [];
  const loader = {
    async loadAsync(url) {
      requested_urls.push(url);
      return { scene: synthetic.model };
    },
  };

  const patient = await loadPatientAvatar("/avatars/synthetic.glb", loader);
  const loaded_model = patient.getObjectByName("patient-avatar-model");

  assert.deepEqual(requested_urls, ["/avatars/synthetic.glb"]);
  assert.notStrictEqual(loaded_model, synthetic.model);
  assert.equal(synthetic.model.name, "synthetic-avatar-source");
  assert.notStrictEqual(patient.userData.avatar_rig.spine, synthetic.spine);
  assert.equal(patient.userData.avatar_rig.spine.name, synthetic.spine.name);
  assert.notStrictEqual(
    loaded_model.getObjectByName("AvatarHead").material,
    synthetic.original_materials.head,
  );
  assert.deepEqual(patient.userData.interactive, {
    id: "patient",
    label: "Assess Daniel Moreau",
  });
});

test("loadPatientAvatar validates URL, loader, and loaded scene", async () => {
  const valid_loader = { loadAsync: async () => ({ scene: new THREE.Group() }) };
  await Promise.all(
    [null, "", 12, {}].map((url) => {
      return assert.rejects(
        loadPatientAvatar(url, valid_loader),
        /url must be a non-empty string/,
      );
    }),
  );
  await Promise.all(
    [null, {}, { loadAsync: true }].map((loader) => {
      return assert.rejects(
        loadPatientAvatar("/avatar.glb", loader),
        /loader must provide loadAsync\(url\)/,
      );
    }),
  );
  await Promise.all(
    [null, {}, { scene: {} }].map((gltf) => {
      return assert.rejects(
        loadPatientAvatar("/avatar.glb", { loadAsync: async () => gltf }, { attempts: 1 }),
        /avatar GLB did not contain a valid scene/,
      );
    }),
  );
});

test("loadPatientAvatar validates its retry options", async () => {
  const valid_loader = { loadAsync: async () => ({ scene: new THREE.Group() }) };
  await Promise.all(
    [0, -1, 1.5, "3", Number.NaN].map((attempts) => {
      return assert.rejects(
        loadPatientAvatar("/avatar.glb", valid_loader, { attempts }),
        /attempts must be an integer of at least 1/,
      );
    }),
  );
  await Promise.all(
    [-1, Number.NaN, Number.POSITIVE_INFINITY, "0"].map((retry_delay_ms) => {
      return assert.rejects(
        loadPatientAvatar("/avatar.glb", valid_loader, { retry_delay_ms }),
        /retry_delay_ms must be a non-negative finite number/,
      );
    }),
  );
});

test("loadPatientAvatar retries a transient failure and then succeeds", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const synthetic = createSyntheticAvatar();
  let call_count = 0;
  const loader = {
    loadAsync: async () => {
      call_count += 1;
      if (call_count === 1) {
        throw new Error("synthetic transient failure");
      }
      return { scene: synthetic.model };
    },
  };

  const patient = await loadPatientAvatar("/avatar.glb", loader, { retry_delay_ms: 1 });
  assert.equal(call_count, 2, "the loader should be retried exactly once after one failure");
  assert.ok(patient.getObjectByName("patient-avatar-model"));
  assert.equal(patient.userData.avatar_source, "Rohy AvatarSDK full-body GLB");
});

test("loadPatientAvatar exhausts its attempts and propagates the final failure", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const loader_error = new Error("synthetic network failure");
  let call_count = 0;
  const loader = {
    loadAsync: async () => {
      call_count += 1;
      throw loader_error;
    },
  };

  await assert.rejects(
    loadPatientAvatar("/avatar.glb", loader, { attempts: 3, retry_delay_ms: 1 }),
    (error) => error === loader_error,
  );
  assert.equal(call_count, 3, "every configured attempt should be used before failing");
});

test("createMonitor builds a tagged monitor with LED and waveform references", () => {
  const monitor = createMonitor();
  const status_led = monitor.getObjectByName("monitor-status-led");
  const waveform = monitor.getObjectByName("monitor-waveform");

  assert.ok(monitor instanceof THREE.Group);
  assert.equal(monitor.name, "vital-sign-monitor");
  assert.deepEqual(monitor.userData.interactive, {
    id: "monitor",
    label: "View bedside monitor",
  });
  assert.strictEqual(monitor.userData.status_led, status_led);
  assert.ok(status_led instanceof THREE.Mesh);
  assert.ok(waveform instanceof THREE.Line);
  assert.equal(waveform.geometry.getAttribute("position").count, 70);
  assert.equal(monitor.getObjectByName("monitor-screen").userData.status_light, true);
  ["monitor-shell", "monitor-screen", "monitor-pole", "monitor-base"].forEach(
    (name) => assert.ok(monitor.getObjectByName(name) instanceof THREE.Mesh),
  );
});

test("createOxygenStation builds the cylinder, wall panel, and three ports", () => {
  const oxygen = createOxygenStation();
  const ports = directChildrenNamed(oxygen, "oxygen-port");

  assert.ok(oxygen instanceof THREE.Group);
  assert.equal(oxygen.name, "oxygen-station");
  assert.deepEqual(oxygen.userData.interactive, {
    id: "oxygen",
    label: "Controlled oxygen",
  });
  assert.ok(oxygen.getObjectByName("oxygen-cylinder") instanceof THREE.Mesh);
  assert.ok(oxygen.getObjectByName("oxygen-cap") instanceof THREE.Mesh);
  assert.ok(oxygen.getObjectByName("oxygen-panel") instanceof THREE.Mesh);
  assert.equal(ports.length, 3);
  assert.deepEqual(
    ports.map((port) => port.material.color.getHex()),
    [0xffffff, 0x3a7d52, 0x555a5f],
    "gas outlets stay color-coded: oxygen white, air green, vacuum gray",
  );
});

test("updateClinicalScene dispatches physiology to a rigged patient", () => {
  const room = createClinicalRoom();
  const patient = configurePatientAvatar(createSyntheticAvatar().model);
  room.add(patient);

  updateClinicalScene(room, "critical", { respiratory_rate: 15 }, 1);

  const rig = patient.userData.avatar_rig;
  assert.ok(rig.spine.scale.x > rig.spine_rest_scale.x);
  assert.ok(rig.spine.scale.z > rig.spine_rest_scale.z);
  assert.deepEqual(rig.morph_targets[0].morphTargetInfluences.slice(0, 3), [0, 0, 0]);
  rig.morph_targets[0].morphTargetInfluences.slice(3).forEach((influence) => {
    assert.ok(Math.abs(influence - 0.085) < 1e-12);
  });
  assert.equal(
    room.getObjectByName("monitor-status-led").material.color.getHex(),
    0xff725e,
  );
});

test("updateClinicalScene applies status-specific breathing and appearance", () => {
  const room = createClinicalRoom();
  room.add(createPatient());
  const patient = room.getObjectByName("patient-avatar");
  const monitor = room.getObjectByName("vital-sign-monitor");
  const cases = [
    {
      status: "critical",
      breath_intensity: 0.075,
      mouth_scale: 1.24,
      head_intensity: 0.018,
      emissive: 0x521b16,
      emissive_intensity: 0.28,
      light: 0xff725e,
    },
    {
      status: "unstable",
      breath_intensity: 0.055,
      mouth_scale: 1.1,
      head_intensity: 0.008,
      emissive: 0x3f2b12,
      emissive_intensity: 0.18,
      light: 0xffb84a,
    },
    {
      status: "stabilizing",
      breath_intensity: 0.035,
      mouth_scale: 0.9,
      head_intensity: 0.008,
      emissive: 0x173632,
      emissive_intensity: 0.1,
      light: 0x32d9bd,
    },
    {
      status: "stable",
      breath_intensity: 0.035,
      mouth_scale: 0.9,
      head_intensity: 0.008,
      emissive: 0x0c2b22,
      emissive_intensity: 0.06,
      light: 0xa7f3df,
    },
  ];

  cases.forEach((clinical_case) => {
    updateClinicalScene(
      room,
      clinical_case.status,
      { respiratory_rate: 15 },
      1,
    );

    const chest_scale = 1 + clinical_case.breath_intensity;
    assert.ok(
      Math.abs(patient.userData.parts.torso.scale.y - 0.38 * chest_scale) < 1e-12,
    );
    assert.ok(
      Math.abs(patient.userData.parts.chest_panel.scale.y - 0.36 * chest_scale) < 1e-12,
    );
    assert.ok(
      Math.abs(
        patient.userData.parts.head.rotation.z -
          Math.sin(0.7) * clinical_case.head_intensity,
      ) < 1e-12,
    );
    assert.equal(patient.userData.parts.eyes.scale.y, 1);
    assert.equal(patient.userData.parts.mouth.scale.x, clinical_case.mouth_scale);
    assert.equal(
      patient.userData.parts.skin_material.emissive.getHex(),
      clinical_case.emissive,
    );
    assert.equal(
      patient.userData.parts.skin_light_material.emissive.getHex(),
      clinical_case.emissive,
    );
    assert.equal(
      patient.userData.parts.skin_material.emissiveIntensity,
      clinical_case.emissive_intensity,
    );
    assert.equal(monitor.userData.status_led.material.color.getHex(), clinical_case.light);
    assert.equal(monitor.userData.status_led.material.emissive.getHex(), clinical_case.light);
  });
});

test("updateClinicalScene animates blinking and uses the unstable color fallback", () => {
  const room = createClinicalRoom();
  room.add(createPatient());
  const patient = room.getObjectByName("patient-avatar");
  const monitor = room.getObjectByName("vital-sign-monitor");

  updateClinicalScene(room, "unknown-status", { respiratory_rate: 24 }, 0);

  assert.equal(patient.userData.parts.eyes.scale.y, 0.06);
  assert.equal(patient.userData.parts.mouth.scale.x, 0.9);
  assert.equal(patient.userData.parts.skin_material.emissive.getHex(), 0x3f2b12);
  assert.equal(patient.userData.parts.skin_material.emissiveIntensity, 0.18);
  assert.equal(monitor.userData.status_led.material.color.getHex(), 0xffb84a);

  updateClinicalScene(room, "stable", { respiratory_rate: 24 }, 0.5);
  assert.equal(patient.userData.parts.eyes.scale.y, 1);
});

test("updateClinicalScene safely ignores rooms without an animatable patient", () => {
  assert.doesNotThrow(() => {
    updateClinicalScene(
      new THREE.Group(),
      "stable",
      { respiratory_rate: 18 },
      10,
    );
  });
});

test("updateClinicalScene validates its room, vitals, and elapsed time", () => {
  const room = new THREE.Group();

  [null, {}, "room"].forEach((invalid_room) => {
    assert.throws(
      () => updateClinicalScene(invalid_room, "stable", { respiratory_rate: 18 }, 0),
      /room must be a THREE\.Object3D/,
    );
  });
  [null, {}, { respiratory_rate: "18" }, { respiratory_rate: Number.POSITIVE_INFINITY }]
    .forEach((invalid_vitals) => {
      assert.throws(
        () => updateClinicalScene(room, "stable", invalid_vitals, 0),
        /vitals\.respiratory_rate must be numeric/,
      );
    });
  [Number.NaN, Number.NEGATIVE_INFINITY, "0"].forEach((invalid_seconds) => {
    assert.throws(
      () => updateClinicalScene(room, "stable", { respiratory_rate: 18 }, invalid_seconds),
      /elapsed_seconds must be numeric/,
    );
  });
});

test("tagInteractive returns the tagged object and ancestor lookup finds metadata", () => {
  const root = new THREE.Group();
  const child = new THREE.Group();
  const grandchild = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
  );
  root.add(child);
  child.add(grandchild);

  const returned = tagInteractive(root, "patient", "Assess patient");

  assert.strictEqual(returned, root);
  assert.deepEqual(root.userData.interactive, {
    id: "patient",
    label: "Assess patient",
  });
  assert.strictEqual(findInteractiveData(grandchild), root.userData.interactive);
  assert.strictEqual(findInteractiveData(child), root.userData.interactive);

  tagInteractive(child, "monitor", "View monitor");
  assert.strictEqual(findInteractiveData(grandchild), child.userData.interactive);
  assert.equal(findInteractiveData(new THREE.Group()), null);
  assert.equal(findInteractiveData(null), null);
});

test("tagInteractive rejects invalid objects and non-string metadata", () => {
  assert.throws(
    () => tagInteractive({}, "bed", "Adjust bed"),
    /object must be a THREE\.Object3D/,
  );
  assert.throws(
    () => tagInteractive(new THREE.Group(), 3, "Adjust bed"),
    /id and label must be strings/,
  );
  assert.throws(
    () => tagInteractive(new THREE.Group(), "bed", null),
    /id and label must be strings/,
  );
});

test("attachBodyRegions creates invisible raycastable colliders with region data", () => {
  const patient = createPatient();
  const regions = [
    { id: "chestAnterior", label: "Anterior chest", center: [0, 1.5, -0.55], size: [0.85, 0.4, 0.75] },
    { id: "abdomen", label: "Abdomen", center: [0, 1.45, 0.28], size: [0.8, 0.35, 0.8] },
  ];
  const colliders = attachBodyRegions(patient, regions);

  assert.equal(colliders.length, 2);
  assert.strictEqual(patient.userData.body_region_colliders, colliders);
  colliders.forEach((collider, index) => {
    assert.ok(collider instanceof THREE.Mesh);
    assert.equal(collider.name, `body-region-${regions[index].id}`);
    assert.equal(collider.material.opacity, 0, "colliders start invisible");
    assert.equal(collider.material.transparent, true);
    assert.deepEqual(findInteractiveData(collider), {
      id: regions[index].id,
      label: regions[index].label,
      kind: "region",
    });
  });

  // A ray straight down through the chest must hit the chest collider first.
  patient.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 5, -0.55), new THREE.Vector3(0, -1, 0));
  const hit = raycaster.intersectObjects(colliders, false)[0];
  assert.equal(hit.object.name, "body-region-chestAnterior");
});

test("attachBodyRegions validates the patient and every region shape", () => {
  const patient = createPatient();
  assert.throws(() => attachBodyRegions(null, []), /patient must be a THREE.Object3D/);
  assert.throws(() => attachBodyRegions(patient, []), /non-empty array/);
  [
    { label: "x", center: [0, 0, 0], size: [1, 1, 1] },
    { id: "a", label: "x", center: [0, 0], size: [1, 1, 1] },
    { id: "a", label: "x", center: [0, 0, 0], size: [1, 0, 1] },
    { id: "a", label: "", center: [0, 0, 0], size: [1, 1, 1] },
  ].forEach((bad_region) => {
    assert.throws(() => attachBodyRegions(patient, [bad_region]), /every region needs/);
  });
});

test("setColliderMark tints regions by exam state and restores cleanly", () => {
  const patient = createPatient();
  const [collider] = attachBodyRegions(patient, [
    { id: "abdomen", label: "Abdomen", center: [0, 1.45, 0.28], size: [0.8, 0.35, 0.8] },
  ]);

  setColliderMark(collider, "examined");
  assert.equal(collider.userData.mark, "examined");
  assert.equal(collider.userData.base_opacity, 0.06);
  assert.equal(collider.material.color.getHex(), 0x2ae0bd);

  setColliderMark(collider, "abnormal");
  assert.equal(collider.userData.base_opacity, 0.12);
  assert.equal(collider.material.color.getHex(), 0xffb84a);
  assert.equal(collider.material.opacity, 0.12);

  setColliderMark(collider, null);
  assert.equal(collider.userData.mark, null);
  assert.equal(collider.material.opacity, 0);

  assert.throws(() => setColliderMark(collider, "polished"), /Unknown region mark/);
  assert.throws(() => setColliderMark(new THREE.Mesh(), "examined"), /must come from attachBodyRegions/);
});

test("updateRiggedPatient layers a decaying wince over the ambient face drive", () => {
  const rig = createSyntheticAnimationRig();
  const influences = rig.morph_targets[0].morphTargetInfluences;
  const dictionary = rig.morph_targets[0].morphTargetDictionary;

  rig.reaction = { kind: "wince", start_ms: performance.now() };
  updateRiggedPatient(rig, "stable", { respiratory_rate: 14 }, 1);
  assert.ok(influences[dictionary.eyesClosed] > 0.5, "a fresh wince closes the eyes");
  assert.ok(influences[dictionary.jawOpen] > 0.2, "a fresh wince parts the jaw");

  rig.reaction = { kind: "wince", start_ms: performance.now() - 5_000 };
  updateRiggedPatient(rig, "stable", { respiratory_rate: 14 }, 1);
  assert.equal(rig.reaction, null, "an expired reaction clears itself");
  assert.ok(influences[dictionary.eyesClosed] <= 0.001, "the face returns to the ambient drive");
});
