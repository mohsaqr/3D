import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";

const DEFAULT_PATIENT_AVATAR_URL = "/avatars/avatarsdk.glb";

const COLORS = Object.freeze({
  navy: 0x08171c,
  wall: 0x102a2f,
  wall_light: 0x18383b,
  teal: 0x32d9bd,
  teal_dark: 0x0a736c,
  mint: 0xa7f3df,
  coral: 0xff725e,
  amber: 0xffb84a,
  cream: 0xe9f1ea,
  steel: 0x8ba3a5,
  bed: 0xb8d3ce,
  skin: 0xc98d72,
  skin_light: 0xe0aa8d,
  gown: 0x347d87,
  blanket: 0x4f9691,
  charcoal: 0x132024,
});

const CAMERA_PRESETS = Object.freeze({
  overview: {
    position: new THREE.Vector3(6.7, 4.6, 7.1),
    target: new THREE.Vector3(0, 1.3, 0),
  },
  patient: {
    position: new THREE.Vector3(2.35, 2.55, 0.85),
    target: new THREE.Vector3(0, 1.5, -1.1),
  },
  airway: {
    position: new THREE.Vector3(2.4, 2.55, 0.6),
    target: new THREE.Vector3(0, 1.62, -1.25),
  },
  monitor: {
    position: new THREE.Vector3(5.25, 3.15, 0.4),
    target: new THREE.Vector3(3.15, 2.05, -1.25),
  },
  equipment: {
    position: new THREE.Vector3(-4.6, 3.2, 3.1),
    target: new THREE.Vector3(-2.55, 1.45, -0.25),
  },
});

/**
 * Create the complete procedural patient room.
 * @return {THREE.Group} Room group with named equipment.
 * @example
 * const room = createClinicalRoom();
 */
export function createClinicalRoom() {
  const room = new THREE.Group();
  room.name = "clinical-room";

  const floor_material = new THREE.MeshStandardMaterial({
    color: COLORS.navy,
    roughness: 0.78,
    metalness: 0.08,
  });
  const floor = createBox("floor", [12, 0.14, 10], floor_material, [0, -0.08, 0]);
  floor.receiveShadow = true;
  room.add(floor);

  const wall_material = new THREE.MeshStandardMaterial({
    color: COLORS.wall,
    roughness: 0.92,
  });
  room.add(createBox("back-wall", [12, 5.5, 0.18], wall_material, [0, 2.72, -5]));
  room.add(createBox("left-wall", [0.18, 5.5, 10], wall_material, [-6, 2.72, 0]));

  const grid = new THREE.GridHelper(12, 24, COLORS.teal_dark, COLORS.wall_light);
  grid.name = "floor-grid";
  grid.material.transparent = true;
  grid.material.opacity = 0.26;
  grid.position.y = 0.005;
  room.add(grid);

  room.add(createWindow());
  room.add(createBed());
  room.add(createPatientBlanket());
  room.add(createMonitor());
  room.add(createOxygenStation());
  room.add(createIvPole());
  room.add(createCabinet());
  room.add(createExamLamp());
  room.add(createPrivacyCurtain());
  room.add(createWallDetails());

  return room;
}

/**
 * Create a hospital bed from primitive geometry.
 * @return {THREE.Group} Named bed group.
 * @example
 * const bed = createBed();
 */
export function createBed() {
  const group = new THREE.Group();
  group.name = "patient-bed";
  const frame_material = new THREE.MeshStandardMaterial({
    color: COLORS.steel,
    roughness: 0.32,
    metalness: 0.66,
  });
  const mattress_material = new THREE.MeshStandardMaterial({
    color: COLORS.cream,
    roughness: 0.88,
  });
  const accent_material = new THREE.MeshStandardMaterial({
    color: COLORS.teal_dark,
    roughness: 0.45,
  });

  group.add(createBox("bed-frame", [2.35, 0.18, 4.75], frame_material, [0, 0.82, 0]));
  group.add(createBox("mattress", [2.15, 0.3, 4.45], mattress_material, [0, 1.02, 0]));
  group.add(createBox("headboard", [2.38, 1.12, 0.14], accent_material, [0, 1.22, -2.33]));
  group.add(createBox("footboard", [2.38, 0.78, 0.14], accent_material, [0, 1.08, 2.33]));

  [-1.02, 1.02].forEach((x_position) => {
    group.add(createRail(x_position));
  });
  [-0.92, 0.92].forEach((x_position) => {
    [-1.78, 1.78].forEach((z_position) => {
      const leg = createCylinder(
        "bed-leg",
        0.065,
        0.065,
        0.78,
        frame_material,
        [x_position, 0.43, z_position],
      );
      group.add(leg);
      const wheel = new THREE.Mesh(
        new THREE.TorusGeometry(0.12, 0.045, 8, 16),
        new THREE.MeshStandardMaterial({ color: COLORS.charcoal, roughness: 0.62 }),
      );
      wheel.name = "bed-wheel";
      wheel.rotation.y = Math.PI / 2;
      wheel.position.set(x_position, 0.11, z_position);
      group.add(wheel);
    });
  });

  const pillow = new THREE.Mesh(
    new THREE.SphereGeometry(0.58, 32, 18),
    mattress_material,
  );
  pillow.name = "pillow";
  pillow.scale.set(1.3, 0.28, 0.72);
  pillow.position.set(0, 1.3, -1.66);
  pillow.castShadow = true;
  group.add(pillow);

  tagInteractive(group, "bed", "Adjust patient position");
  return group;
}

/**
 * Create the legacy procedural patient used only as a WebGL/model fallback.
 * @return {THREE.Group} Patient group with animation references in userData.parts.
 * @example
 * const patient = createPatient();
 */
export function createPatient() {
  const patient = new THREE.Group();
  patient.name = "patient-avatar";
  const skin_material = new THREE.MeshStandardMaterial({
    color: COLORS.skin,
    roughness: 0.67,
    metalness: 0,
    emissive: 0x25110e,
    emissiveIntensity: 0.08,
  });
  const skin_light_material = skin_material.clone();
  skin_light_material.color.setHex(COLORS.skin_light);
  const gown_material = new THREE.MeshStandardMaterial({
    color: COLORS.gown,
    roughness: 0.86,
  });
  const blanket_material = new THREE.MeshStandardMaterial({
    color: COLORS.blanket,
    roughness: 0.96,
  });
  const hair_material = new THREE.MeshStandardMaterial({
    color: 0x2b2523,
    roughness: 0.95,
  });
  const eye_white_material = new THREE.MeshStandardMaterial({ color: 0xf6f5ec });
  const iris_material = new THREE.MeshStandardMaterial({
    color: 0x275f62,
    emissive: COLORS.teal,
    emissiveIntensity: 0.05,
  });

  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.72, 32, 24), gown_material);
  torso.name = "patient-torso";
  torso.scale.set(0.86, 0.38, 1.28);
  torso.position.set(0, 1.5, -0.35);
  torso.castShadow = true;
  patient.add(torso);

  const chest_panel = new THREE.Mesh(
    new THREE.SphereGeometry(0.66, 32, 20, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x5ca4a4, roughness: 0.82 }),
  );
  chest_panel.name = "patient-gown-panel";
  chest_panel.scale.set(0.86, 0.36, 1.02);
  chest_panel.position.set(0, 1.56, -0.61);
  patient.add(chest_panel);

  const neck = createCylinder(
    "patient-neck",
    0.19,
    0.22,
    0.34,
    skin_material,
    [0, 1.51, -1.1],
  );
  neck.rotation.x = Math.PI / 2;
  patient.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 36, 28), skin_light_material);
  head.name = "patient-head";
  head.scale.set(0.88, 0.72, 1.08);
  head.position.set(0, 1.61, -1.37);
  head.castShadow = true;
  patient.add(head);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.39, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    hair_material,
  );
  hair.name = "patient-hair";
  hair.scale.set(0.91, 0.75, 1.1);
  hair.position.set(0, 1.63, -1.39);
  hair.rotation.x = Math.PI;
  patient.add(hair);

  const eyes = new THREE.Group();
  eyes.name = "patient-eyes";
  [-0.13, 0.13].forEach((x_position) => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 18, 12), eye_white_material);
    eye.scale.set(1, 0.42, 0.7);
    eye.position.set(x_position, 1.885, -1.49);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 10), iris_material);
    iris.position.set(x_position, 1.915, -1.515);
    eyes.add(eye, iris);
  });
  patient.add(eyes);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.14, 16), skin_light_material);
  nose.name = "patient-nose";
  nose.position.set(0, 1.89, -1.58);
  nose.rotation.x = -0.08;
  patient.add(nose);

  const mouth = new THREE.Mesh(
    new THREE.TorusGeometry(0.075, 0.014, 8, 24, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0x7e3540, roughness: 0.65 }),
  );
  mouth.name = "patient-mouth";
  mouth.position.set(0, 1.865, -1.67);
  mouth.rotation.set(Math.PI / 2, 0, Math.PI);
  patient.add(mouth);

  [-1, 1].forEach((direction) => {
    const upper_arm = createCapsule(
      "patient-arm",
      0.14,
      0.72,
      skin_material,
      [direction * 0.68, 1.39, -0.4],
    );
    upper_arm.rotation.x = Math.PI / 2;
    upper_arm.rotation.z = direction * -0.08;
    patient.add(upper_arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 14), skin_light_material);
    hand.name = "patient-hand";
    hand.scale.set(0.72, 0.38, 1.1);
    hand.position.set(direction * 0.75, 1.39, 0.18);
    hand.castShadow = true;
    patient.add(hand);
  });

  const blanket = createBox(
    "patient-blanket",
    [1.55, 0.18, 2.03],
    blanket_material,
    [0, 1.42, 1.12],
  );
  blanket.rotation.x = -0.025;
  patient.add(blanket);

  [-0.34, 0.34].forEach((x_position) => {
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 14), skin_material);
    foot.name = "patient-foot";
    foot.scale.set(0.82, 0.48, 1.35);
    foot.position.set(x_position, 1.34, 2.05);
    foot.castShadow = true;
    patient.add(foot);
  });

  patient.userData.parts = {
    torso,
    chest_panel,
    head,
    eyes,
    mouth,
    skin_material,
    skin_light_material,
  };
  tagInteractive(patient, "patient", "Assess Daniel Moreau");
  return patient;
}

/**
 * Load and configure Rohy's existing full-body AvatarSDK patient.
 * @param {string} url GLB asset URL.
 * @param {{loadAsync: (url: string) => Promise<{scene: THREE.Object3D}>}} [loader] GLTF loader.
 * @return {Promise<THREE.Group>} Configured patient wrapper.
 * @example
 * const patient = await loadPatientAvatar("/avatars/patient.glb");
 */
export async function loadPatientAvatar(url, loader = new GLTFLoader()) {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("url must be a non-empty string.");
  }
  if (!loader || typeof loader.loadAsync !== "function") {
    throw new Error("loader must provide loadAsync(url).");
  }
  const gltf = await loader.loadAsync(url);
  if (!(gltf?.scene instanceof THREE.Object3D)) {
    throw new Error("The avatar GLB did not contain a valid scene.");
  }
  return configurePatientAvatar(cloneSkeleton(gltf.scene));
}

/**
 * Convert a full-body humanoid scene into a recumbent Rohy patient.
 * @param {THREE.Object3D} model Loaded avatar scene.
 * @return {THREE.Group} Patient wrapper with a normalized animation rig.
 * @example
 * configurePatientAvatar(new THREE.Group());
 */
export function configurePatientAvatar(model) {
  if (!(model instanceof THREE.Object3D)) {
    throw new Error("model must be a THREE.Object3D.");
  }

  const patient = new THREE.Group();
  patient.name = "patient-avatar";
  model.name = "patient-avatar-model";
  model.scale.setScalar(1.72);
  model.rotation.x = -Math.PI / 2;
  model.position.set(0, 1.32, 1.43);
  patient.add(model);

  const morph_targets = [];
  const skin_materials = [];
  model.traverse((object) => {
    if (!object.isMesh && !object.isSkinnedMesh) {
      return;
    }
    object.castShadow = true;
    object.receiveShadow = true;
    object.frustumCulled = false;
    if (Array.isArray(object.material)) {
      object.material = object.material.map((material) => material.clone());
    } else if (object.material) {
      object.material = object.material.clone();
    }
    if (object.morphTargetDictionary && object.morphTargetInfluences) {
      morph_targets.push(object);
    }
    if (/avatar(head|body)/i.test(object.name)) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.filter(Boolean).forEach((material) => {
        skin_materials.push({
          material,
          base_color: material.color?.clone() ?? null,
          base_emissive: material.emissive?.clone() ?? null,
          base_emissive_intensity: material.emissiveIntensity ?? 0,
        });
      });
    }
  });

  patient.updateMatrixWorld(true);
  poseAvatarInBed(patient);

  const rig = {
    model,
    spine: findAvatarBone(model, ["Spine2", "UpperChest", "Chest"]),
    head: findAvatarBone(model, ["Head", "Bip01 Head"]),
    left_shoulder: findAvatarBone(model, ["LeftShoulder", "Bip01 L Clavicle"]),
    right_shoulder: findAvatarBone(model, ["RightShoulder", "Bip01 R Clavicle"]),
    morph_targets,
    skin_materials,
  };
  rig.spine_rest_scale = rig.spine?.scale.clone() ?? null;
  rig.head_rest_quaternion = rig.head?.quaternion.clone() ?? null;
  rig.left_shoulder_rest_quaternion = rig.left_shoulder?.quaternion.clone() ?? null;
  rig.right_shoulder_rest_quaternion = rig.right_shoulder?.quaternion.clone() ?? null;
  patient.userData.avatar_rig = rig;
  patient.userData.avatar_source = "Rohy AvatarSDK full-body GLB";
  tagInteractive(patient, "patient", "Assess Daniel Moreau");
  return patient;
}

/**
 * Find a bone while tolerating glTF name sanitization and rig-family differences.
 * @param {THREE.Object3D} root Avatar root.
 * @param {string[]} candidate_names Acceptable bone names.
 * @return {THREE.Bone|null} Matching bone, if present.
 * @example
 * findAvatarBone(new THREE.Group(), ["Head"]);
 */
export function findAvatarBone(root, candidate_names) {
  if (!(root instanceof THREE.Object3D)) {
    throw new Error("root must be a THREE.Object3D.");
  }
  if (!Array.isArray(candidate_names) || candidate_names.some((name) => typeof name !== "string")) {
    throw new Error("candidate_names must be an array of strings.");
  }
  const normalize_name = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates = new Set(candidate_names.map(normalize_name));
  let matched_bone = null;
  root.traverse((object) => {
    if (!matched_bone && object.isBone && candidates.has(normalize_name(object.name))) {
      matched_bone = object;
    }
  });
  return matched_bone;
}

/**
 * Aim a bone's first segment toward a world-space direction.
 * @param {THREE.Bone} bone Bone to rotate.
 * @param {THREE.Bone} child Child joint defining the current segment direction.
 * @param {THREE.Vector3} desired_direction Desired world-space direction.
 * @return {THREE.Bone} Rotated bone.
 * @example
 * aimBoneAtWorldDirection(upperArm, forearm, new THREE.Vector3(0, 0, 1));
 */
export function aimBoneAtWorldDirection(bone, child, desired_direction) {
  if (!(bone?.isBone && child?.isBone)) {
    throw new Error("bone and child must be THREE.Bone instances.");
  }
  if (!(desired_direction instanceof THREE.Vector3) || desired_direction.lengthSq() === 0) {
    throw new Error("desired_direction must be a non-zero THREE.Vector3.");
  }

  bone.parent?.updateWorldMatrix(true, true);
  const bone_position = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
  const child_position = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
  const current_direction = child_position.sub(bone_position).normalize();
  const target_direction = desired_direction.clone().normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(current_direction, target_direction);
  const current_world_quaternion = new THREE.Quaternion();
  bone.getWorldQuaternion(current_world_quaternion);
  const target_world_quaternion = delta.multiply(current_world_quaternion);
  const parent_world_quaternion = new THREE.Quaternion();
  bone.parent?.getWorldQuaternion(parent_world_quaternion);
  bone.quaternion.copy(parent_world_quaternion.invert().multiply(target_world_quaternion));
  bone.updateWorldMatrix(false, true);
  return bone;
}

/**
 * Apply a neutral supine patient pose to standard and RocketBox humanoid rigs.
 * @param {THREE.Object3D} patient Patient wrapper.
 * @return {THREE.Object3D} The posed patient.
 * @example
 * poseAvatarInBed(configurePatientAvatar(model));
 */
export function poseAvatarInBed(patient) {
  if (!(patient instanceof THREE.Object3D)) {
    throw new Error("patient must be a THREE.Object3D.");
  }
  const model = patient.getObjectByName("patient-avatar-model") ?? patient;
  const arm_pairs = [
    {
      side: 1,
      upper: findAvatarBone(model, ["LeftArm", "Bip01 L UpperArm"]),
      forearm: findAvatarBone(model, ["LeftForeArm", "Bip01 L Forearm"]),
      hand: findAvatarBone(model, ["LeftHand", "Bip01 L Hand"]),
    },
    {
      side: -1,
      upper: findAvatarBone(model, ["RightArm", "Bip01 R UpperArm"]),
      forearm: findAvatarBone(model, ["RightForeArm", "Bip01 R Forearm"]),
      hand: findAvatarBone(model, ["RightHand", "Bip01 R Hand"]),
    },
  ];
  arm_pairs.forEach(({ side, upper, forearm, hand }) => {
    if (upper && forearm) {
      aimBoneAtWorldDirection(upper, forearm, new THREE.Vector3(side * 0.1, -0.03, 1));
    }
    if (forearm && hand) {
      aimBoneAtWorldDirection(forearm, hand, new THREE.Vector3(side * 0.035, 0.015, 1));
    }
  });
  patient.updateMatrixWorld(true);
  return patient;
}

/**
 * Animate a rigged patient's breathing, blinking, effort, and complexion.
 * @param {object} rig Normalized avatar rig.
 * @param {string} status Current clinical status.
 * @param {object} vitals Current vital signs.
 * @param {number} elapsed_seconds Scenario time.
 * @return {void}
 * @example
 * updateRiggedPatient(patient.userData.avatar_rig, "critical", { respiratory_rate: 30 }, 0);
 */
export function updateRiggedPatient(rig, status, vitals, elapsed_seconds) {
  if (!rig || typeof rig !== "object") {
    throw new Error("rig must be an object.");
  }
  if (!vitals || !Number.isFinite(vitals.respiratory_rate)) {
    throw new Error("vitals.respiratory_rate must be numeric.");
  }
  if (!Number.isFinite(elapsed_seconds)) {
    throw new Error("elapsed_seconds must be numeric.");
  }

  const breath_frequency = vitals.respiratory_rate / 60;
  const breath_phase = elapsed_seconds * Math.PI * 2 * breath_frequency;
  const effort = status === "critical" ? 1 : status === "unstable" ? 0.72 : status === "stabilizing" ? 0.42 : 0.28;
  const breath_wave = Math.sin(breath_phase);
  if (rig.spine && rig.spine_rest_scale) {
    rig.spine.scale.set(
      rig.spine_rest_scale.x * (1 + breath_wave * 0.035 * effort),
      rig.spine_rest_scale.y,
      rig.spine_rest_scale.z * (1 + breath_wave * 0.055 * effort),
    );
  }
  if (rig.head && rig.head_rest_quaternion) {
    const head_offset = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.sin(elapsed_seconds * 0.55) * 0.012 * effort,
    );
    rig.head.quaternion.copy(rig.head_rest_quaternion).multiply(head_offset);
  }
  [
    [rig.left_shoulder, rig.left_shoulder_rest_quaternion, 1],
    [rig.right_shoulder, rig.right_shoulder_rest_quaternion, -1],
  ].forEach(([shoulder, rest_quaternion, direction]) => {
    if (!shoulder || !rest_quaternion) return;
    const shoulder_offset = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      direction * Math.max(0, breath_wave) * 0.02 * effort,
    );
    shoulder.quaternion.copy(rest_quaternion).multiply(shoulder_offset);
  });

  const blink = elapsed_seconds % 4.6 < 0.13 ? 1 : 0;
  const mouth_open = (0.035 + Math.max(0, breath_wave) * 0.05) * effort;
  rig.morph_targets?.forEach((mesh) => {
    const dictionary = mesh.morphTargetDictionary;
    const influences = mesh.morphTargetInfluences;
    ["eyeBlinkLeft", "eyeBlinkRight", "eyesClosed"].forEach((name) => {
      const index = dictionary?.[name];
      if (index != null) influences[index] = blink;
    });
    ["jawOpen", "mouthOpen", "viseme_O"].forEach((name) => {
      const index = dictionary?.[name];
      if (index != null) influences[index] = mouth_open;
    });
  });

  const complexion = {
    critical: { color: new THREE.Color(0xc8d3d0), amount: 0.22, emissive: 0x26191a },
    unstable: { color: new THREE.Color(0xe0d1c7), amount: 0.12, emissive: 0x211817 },
    stabilizing: { color: new THREE.Color(0xffffff), amount: 0.035, emissive: 0x101818 },
    stable: { color: new THREE.Color(0xffffff), amount: 0, emissive: 0x000000 },
  }[status] ?? { color: new THREE.Color(0xe0d1c7), amount: 0.12, emissive: 0x211817 };
  rig.skin_materials?.forEach(({ material, base_color, base_emissive, base_emissive_intensity }) => {
    if (material.color && base_color) {
      material.color.copy(base_color).lerp(complexion.color, complexion.amount);
    }
    if (material.emissive) {
      material.emissive.copy(base_emissive ?? new THREE.Color(0x000000)).lerp(
        new THREE.Color(complexion.emissive),
        complexion.amount,
      );
      material.emissiveIntensity = Math.max(base_emissive_intensity, complexion.amount * 0.28);
    }
  });
}

function createPatientBlanket() {
  const group = new THREE.Group();
  group.name = "patient-bed-cover";
  const blanket_material = new THREE.MeshStandardMaterial({
    color: COLORS.blanket,
    roughness: 0.94,
  });
  const blanket_geometry = new THREE.PlaneGeometry(1.62, 2.02, 24, 32);
  const positions = blanket_geometry.attributes.position;
  const vertex = new THREE.Vector3();
  Array.from({ length: positions.count }, (_, index) => index).forEach((index) => {
    vertex.fromBufferAttribute(positions, index);
    const width_profile = Math.max(0, 1 - (vertex.x / 0.88) ** 4);
    const body_profile = 0.12 + 0.16 * Math.exp(-1 * ((vertex.y - 0.2) / 0.72) ** 2);
    const soft_fold = Math.sin(vertex.y * 16 + vertex.x * 5) * 0.018;
    const edge_drop = 0.09 * Math.abs(vertex.x / 0.81) ** 5;
    positions.setZ(index, body_profile * width_profile + soft_fold - edge_drop);
  });
  blanket_geometry.computeVertexNormals();
  const blanket = new THREE.Mesh(blanket_geometry, blanket_material);
  blanket.name = "patient-blanket";
  blanket.rotation.x = -Math.PI / 2;
  blanket.position.set(0, 1.43, 0.56);
  blanket.castShadow = true;
  blanket.receiveShadow = true;
  group.add(blanket);
  return group;
}

/**
 * Create a physical bedside vital-sign monitor.
 * @return {THREE.Group} Monitor group.
 * @example
 * const monitor = createMonitor();
 */
export function createMonitor() {
  const group = new THREE.Group();
  group.name = "vital-sign-monitor";
  const shell_material = new THREE.MeshStandardMaterial({
    color: 0x294044,
    roughness: 0.35,
    metalness: 0.32,
  });
  const screen_material = new THREE.MeshStandardMaterial({
    color: 0x061316,
    emissive: 0x0a504b,
    emissiveIntensity: 0.3,
    roughness: 0.22,
  });

  group.add(createBox("monitor-shell", [1.55, 1.04, 0.22], shell_material, [3.2, 2.45, -1.47]));
  const screen = createBox("monitor-screen", [1.37, 0.84, 0.04], screen_material, [3.2, 2.45, -1.335]);
  screen.userData.status_light = true;
  group.add(screen);
  group.add(createCylinder("monitor-pole", 0.055, 0.065, 1.62, shell_material, [3.2, 1.28, -1.52]));
  group.add(createBox("monitor-base", [0.8, 0.1, 0.58], shell_material, [3.2, 0.48, -1.5]));

  const status_led = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 12),
    new THREE.MeshStandardMaterial({
      color: COLORS.coral,
      emissive: COLORS.coral,
      emissiveIntensity: 2,
    }),
  );
  status_led.name = "monitor-status-led";
  status_led.position.set(3.76, 2.77, -1.29);
  group.add(status_led);
  group.userData.status_led = status_led;

  const monitor_wave = createMonitorWave();
  monitor_wave.position.set(3.2, 2.35, -1.305);
  group.add(monitor_wave);

  tagInteractive(group, "monitor", "View bedside monitor");
  return group;
}

/**
 * Create the oxygen wall station and cylinder.
 * @return {THREE.Group} Oxygen equipment group.
 * @example
 * const oxygen = createOxygenStation();
 */
export function createOxygenStation() {
  const group = new THREE.Group();
  group.name = "oxygen-station";
  const metal = new THREE.MeshStandardMaterial({
    color: COLORS.steel,
    roughness: 0.4,
    metalness: 0.55,
  });
  const green = new THREE.MeshStandardMaterial({
    color: COLORS.teal_dark,
    roughness: 0.48,
  });

  const cylinder = createCylinder("oxygen-cylinder", 0.27, 0.3, 1.35, green, [-3.55, 0.72, -1.15]);
  cylinder.castShadow = true;
  group.add(cylinder);
  group.add(createCylinder("oxygen-cap", 0.12, 0.18, 0.2, metal, [-3.55, 1.49, -1.15]));
  group.add(createBox("oxygen-panel", [1.35, 0.72, 0.16], metal, [-3.25, 2.72, -4.84]));

  [-3.62, -3.15, -2.68].forEach((x_position, index) => {
    const port = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.12, 20),
      new THREE.MeshStandardMaterial({
        color: index === 0 ? COLORS.teal : index === 1 ? COLORS.amber : COLORS.steel,
        emissive: index === 0 ? COLORS.teal_dark : 0,
        emissiveIntensity: 0.45,
      }),
    );
    port.name = "oxygen-port";
    port.rotation.x = Math.PI / 2;
    port.position.set(x_position, 2.72, -4.72);
    group.add(port);
  });
  tagInteractive(group, "oxygen", "Controlled oxygen");
  return group;
}

/**
 * Update visual patient state and bedside monitor light.
 * @param {THREE.Object3D} room Clinical room.
 * @param {string} status Current clinical status.
 * @param {object} vitals Current vital signs.
 * @param {number} elapsed_seconds Scenario time.
 * @return {void}
 * @example
 * updateClinicalScene(createClinicalRoom(), "critical", { respiratory_rate: 30 }, 0);
 */
export function updateClinicalScene(room, status, vitals, elapsed_seconds) {
  if (!(room instanceof THREE.Object3D)) {
    throw new Error("room must be a THREE.Object3D.");
  }
  if (!vitals || !Number.isFinite(vitals.respiratory_rate)) {
    throw new Error("vitals.respiratory_rate must be numeric.");
  }
  if (!Number.isFinite(elapsed_seconds)) {
    throw new Error("elapsed_seconds must be numeric.");
  }

  const patient = room.getObjectByName("patient-avatar");
  const monitor = room.getObjectByName("vital-sign-monitor");
  const state_colors = {
    critical: { emissive: 0x521b16, intensity: 0.28, light: COLORS.coral },
    unstable: { emissive: 0x3f2b12, intensity: 0.18, light: COLORS.amber },
    stabilizing: { emissive: 0x173632, intensity: 0.1, light: COLORS.teal },
    stable: { emissive: 0x0c2b22, intensity: 0.06, light: COLORS.mint },
  };
  const state_color = state_colors[status] ?? state_colors.unstable;

  if (patient?.userData.avatar_rig) {
    updateRiggedPatient(patient.userData.avatar_rig, status, vitals, elapsed_seconds);
  } else if (patient?.userData.parts) {
    const { torso, chest_panel, head, eyes, mouth, skin_material, skin_light_material } = patient.userData.parts;
    const breath_frequency = vitals.respiratory_rate / 60;
    const breath_phase = elapsed_seconds * Math.PI * 2 * breath_frequency;
    const breath_intensity = status === "critical" ? 0.075 : status === "unstable" ? 0.055 : 0.035;
    const chest_scale = 1 + Math.sin(breath_phase) * breath_intensity;
    torso.scale.y = 0.38 * chest_scale;
    chest_panel.scale.y = 0.36 * chest_scale;
    head.rotation.z = Math.sin(elapsed_seconds * 0.7) * (status === "critical" ? 0.018 : 0.008);

    const blink_phase = elapsed_seconds % 4.6;
    eyes.scale.y = blink_phase < 0.12 ? 0.06 : 1;
    mouth.scale.x = status === "critical" ? 1.24 : status === "unstable" ? 1.1 : 0.9;
    skin_material.emissive.setHex(state_color.emissive);
    skin_material.emissiveIntensity = state_color.intensity;
    skin_light_material.emissive.setHex(state_color.emissive);
    skin_light_material.emissiveIntensity = state_color.intensity;
  }

  if (monitor?.userData.status_led) {
    monitor.userData.status_led.material.color.setHex(state_color.light);
    monitor.userData.status_led.material.emissive.setHex(state_color.light);
  }
}

/**
 * Initialize and animate the Three.js clinical scene.
 * @param {HTMLElement} container Canvas parent element.
 * @param {(selection: {id: string, label: string}) => void} [on_select] Selection callback.
 * @return {{focusPreset: Function, update: Function, dispose: Function, renderer: THREE.WebGLRenderer, ready: Promise<THREE.Object3D>}}
 * Scene controller.
 * @example
 * const controller = initClinicalScene(document.body);
 */
export function initClinicalScene(container, on_select = () => {}) {
  if (!(container instanceof HTMLElement)) {
    throw new Error("container must be an HTMLElement.");
  }
  if (typeof on_select !== "function") {
    throw new Error("on_select must be a function.");
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.navy);
  scene.fog = new THREE.FogExp2(COLORS.navy, 0.035);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.copy(CAMERA_PRESETS.overview.position);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.setAttribute("aria-label", "Interactive 3D clinical room with Daniel in bed");
  renderer.domElement.setAttribute("role", "img");
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAMERA_PRESETS.overview.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.enablePan = false;
  controls.minDistance = 2.8;
  controls.maxDistance = 11;
  controls.minPolarAngle = Math.PI * 0.17;
  controls.maxPolarAngle = Math.PI * 0.48;

  scene.add(new THREE.HemisphereLight(0xb6fff0, 0x173038, 1.9));
  const key_light = new THREE.SpotLight(0xfff0db, 48, 22, Math.PI / 5.5, 0.52, 1.2);
  key_light.position.set(1.2, 7.8, 2.6);
  key_light.target.position.set(0, 1, 0);
  key_light.castShadow = true;
  key_light.shadow.mapSize.set(1024, 1024);
  scene.add(key_light, key_light.target);
  const accent_light = new THREE.PointLight(COLORS.teal, 12, 8, 1.5);
  accent_light.position.set(-3.5, 2.8, -2.5);
  scene.add(accent_light);
  const monitor_light = new THREE.PointLight(COLORS.coral, 4, 4, 1.8);
  monitor_light.position.set(3.2, 2.4, -0.7);
  scene.add(monitor_light);

  let disposed = false;
  let current_status = "critical";
  let current_vitals = { respiratory_rate: 30 };
  let elapsed_seconds = 0;
  let camera_transition = null;
  const room = createClinicalRoom();
  scene.add(room);
  container.dataset.avatarReady = "loading";
  const avatar_ready = loadPatientAvatar(DEFAULT_PATIENT_AVATAR_URL)
    .then((patient) => {
      if (disposed) {
        disposeObject(patient);
        return patient;
      }
      const max_anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
      patient.traverse((object) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.filter(Boolean).forEach((material) => {
          [material.map, material.normalMap, material.roughnessMap].filter(Boolean).forEach((texture) => {
            texture.anisotropy = max_anisotropy;
            texture.needsUpdate = true;
          });
        });
      });
      room.add(patient);
      updateClinicalScene(room, current_status, current_vitals, elapsed_seconds);
      container.dataset.avatarReady = "true";
      container.dataset.avatarSource = patient.userData.avatar_source;
      return patient;
    })
    .catch((error) => {
      if (!disposed) {
        const fallback_patient = createPatient();
        fallback_patient.userData.avatar_source = "procedural fallback";
        room.add(fallback_patient);
        container.dataset.avatarReady = "fallback";
        console.warn("The full-body Rohy avatar could not load; using the fallback patient.", error);
        return fallback_patient;
      }
      throw error;
    });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let frame_id = 0;

  const handle_pointer = (event) => {
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(room, true).find((intersection) => {
      return findInteractiveData(intersection.object);
    });
    if (hit) {
      on_select(findInteractiveData(hit.object));
    }
  };
  renderer.domElement.addEventListener("click", handle_pointer);

  const resize = () => {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resize_observer = new ResizeObserver(resize);
  resize_observer.observe(container);
  resize();

  const animate = (time_ms) => {
    if (disposed) {
      return;
    }
    frame_id = window.requestAnimationFrame(animate);
    const visual_time = elapsed_seconds + time_ms / 1000;
    updateClinicalScene(room, current_status, current_vitals, visual_time);

    if (camera_transition) {
      const progress = Math.min((time_ms - camera_transition.start) / 680, 1);
      const eased = 1 - (1 - progress) ** 3;
      camera.position.lerpVectors(camera_transition.from_position, camera_transition.to_position, eased);
      controls.target.lerpVectors(camera_transition.from_target, camera_transition.to_target, eased);
      if (progress >= 1) {
        camera_transition = null;
      }
    }
    controls.update();
    renderer.render(scene, camera);
  };
  frame_id = window.requestAnimationFrame(animate);

  return {
    renderer,
    ready: avatar_ready,
    focusPreset(preset_name) {
      const preset = CAMERA_PRESETS[preset_name];
      if (!preset) {
        throw new Error(`Unknown camera preset: ${preset_name}`);
      }
      camera_transition = {
        start: performance.now(),
        from_position: camera.position.clone(),
        from_target: controls.target.clone(),
        to_position: preset.position,
        to_target: preset.target,
      };
    },
    update(status, vitals, seconds) {
      current_status = status;
      current_vitals = vitals;
      elapsed_seconds = seconds;
    },
    dispose() {
      disposed = true;
      window.cancelAnimationFrame(frame_id);
      resize_observer.disconnect();
      renderer.domElement.removeEventListener("click", handle_pointer);
      controls.dispose();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/**
 * Mark an object hierarchy as interactable.
 * @param {THREE.Object3D} object Root object.
 * @param {string} id Selection id.
 * @param {string} label Accessible label.
 * @return {THREE.Object3D} The same tagged object.
 * @example
 * tagInteractive(new THREE.Group(), "patient", "Assess patient");
 */
export function tagInteractive(object, id, label) {
  if (!(object instanceof THREE.Object3D)) {
    throw new Error("object must be a THREE.Object3D.");
  }
  if (typeof id !== "string" || typeof label !== "string") {
    throw new Error("id and label must be strings.");
  }
  object.userData.interactive = { id, label };
  return object;
}

/**
 * Find interaction metadata by walking up an object's ancestors.
 * @param {THREE.Object3D} object Scene object.
 * @return {{id: string, label: string}|null} Interaction metadata.
 * @example
 * findInteractiveData(tagInteractive(new THREE.Group(), "bed", "Bed"));
 */
export function findInteractiveData(object) {
  let current_object = object;
  while (current_object) {
    if (current_object.userData?.interactive) {
      return current_object.userData.interactive;
    }
    current_object = current_object.parent;
  }
  return null;
}

function createWindow() {
  const group = new THREE.Group();
  group.name = "room-window";
  const glass_material = new THREE.MeshStandardMaterial({
    color: 0x8ee6dc,
    emissive: 0x4ebbb1,
    emissiveIntensity: 0.28,
    transparent: true,
    opacity: 0.33,
    roughness: 0.18,
  });
  const frame_material = new THREE.MeshStandardMaterial({
    color: COLORS.steel,
    metalness: 0.55,
    roughness: 0.35,
  });
  group.add(createBox("window-glass", [4.05, 2.2, 0.06], glass_material, [0.7, 3.55, -4.84]));
  [-1.33, 2.73].forEach((x_position) => {
    group.add(createBox("window-frame", [0.08, 2.35, 0.12], frame_material, [x_position, 3.55, -4.75]));
  });
  group.add(createBox("window-frame", [4.14, 0.08, 0.12], frame_material, [0.7, 2.43, -4.75]));
  group.add(createBox("window-frame", [4.14, 0.08, 0.12], frame_material, [0.7, 4.67, -4.75]));
  group.add(createBox("window-frame", [0.06, 2.2, 0.12], frame_material, [0.7, 3.55, -4.75]));
  return group;
}

function createRail(x_position) {
  const group = new THREE.Group();
  group.name = "bed-rail";
  const rail_material = new THREE.MeshStandardMaterial({
    color: COLORS.steel,
    roughness: 0.3,
    metalness: 0.72,
  });
  group.add(createBox("rail-top", [0.07, 0.07, 2.95], rail_material, [x_position, 1.62, 0.15]));
  [-1.12, -0.38, 0.38, 1.12].forEach((z_position) => {
    group.add(createCylinder("rail-post", 0.03, 0.03, 0.5, rail_material, [x_position, 1.37, z_position]));
  });
  return group;
}

function createIvPole() {
  const group = new THREE.Group();
  group.name = "iv-pole";
  const metal = new THREE.MeshStandardMaterial({
    color: COLORS.steel,
    roughness: 0.26,
    metalness: 0.76,
  });
  group.add(createCylinder("iv-stand", 0.035, 0.055, 2.78, metal, [-2.27, 1.44, -0.65]));
  group.add(createBox("iv-hook", [0.66, 0.035, 0.035], metal, [-2.27, 2.85, -0.65]));
  group.add(createBox("iv-base", [0.82, 0.06, 0.48], metal, [-2.27, 0.08, -0.65]));
  const bag_material = new THREE.MeshPhysicalMaterial({
    color: 0xd4fff5,
    transparent: true,
    opacity: 0.55,
    roughness: 0.18,
    transmission: 0.35,
  });
  const bag = createBox("iv-bag", [0.34, 0.64, 0.12], bag_material, [-2.04, 2.46, -0.65]);
  group.add(bag);
  tagInteractive(group, "iv", "IV equipment");
  return group;
}

function createCabinet() {
  const group = new THREE.Group();
  group.name = "bedside-cabinet";
  const body_material = new THREE.MeshStandardMaterial({
    color: 0x2d5558,
    roughness: 0.72,
  });
  const top_material = new THREE.MeshStandardMaterial({
    color: COLORS.bed,
    roughness: 0.62,
  });
  group.add(createBox("cabinet-body", [1.25, 1.03, 0.94], body_material, [-3.35, 0.54, 1.22]));
  group.add(createBox("cabinet-top", [1.36, 0.09, 1.04], top_material, [-3.35, 1.1, 1.22]));
  [-0.14, 0.22].forEach((y_offset) => {
    group.add(createBox("cabinet-drawer", [1.06, 0.24, 0.05], top_material, [-3.35, 0.74 + y_offset, 1.71]));
  });
  tagInteractive(group, "chart", "Open clinical chart");
  return group;
}

function createExamLamp() {
  const group = new THREE.Group();
  group.name = "exam-lamp";
  const metal = new THREE.MeshStandardMaterial({
    color: COLORS.steel,
    roughness: 0.35,
    metalness: 0.6,
  });
  group.add(createCylinder("lamp-pole", 0.04, 0.06, 2.1, metal, [4.35, 1.1, 1.7]));
  const arm = createCylinder("lamp-arm", 0.035, 0.035, 1.25, metal, [4.0, 2.28, 1.42]);
  arm.rotation.z = -0.95;
  group.add(arm);
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.38, 0.32, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x31585a, roughness: 0.42 }),
  );
  shade.name = "exam-lamp-shade";
  shade.rotation.z = -0.72;
  shade.position.set(3.62, 2.75, 1.1);
  group.add(shade);
  return group;
}

function createPrivacyCurtain() {
  const group = new THREE.Group();
  group.name = "privacy-curtain";
  const curtain_material = new THREE.MeshStandardMaterial({
    color: 0x27595b,
    roughness: 0.98,
    side: THREE.DoubleSide,
  });
  const curtain = createBox("curtain-fabric", [0.08, 3.35, 4.3], curtain_material, [-5.45, 2.15, 1.9]);
  group.add(curtain);
  const rail_material = new THREE.MeshStandardMaterial({
    color: COLORS.steel,
    metalness: 0.65,
    roughness: 0.28,
  });
  group.add(createBox("curtain-rail", [0.1, 0.1, 4.55], rail_material, [-5.45, 4.03, 1.9]));
  return group;
}

function createWallDetails() {
  const group = new THREE.Group();
  group.name = "wall-details";
  const panel_material = new THREE.MeshStandardMaterial({
    color: 0x214348,
    roughness: 0.62,
  });
  const light_material = new THREE.MeshStandardMaterial({
    color: COLORS.mint,
    emissive: COLORS.teal,
    emissiveIntensity: 0.7,
  });
  group.add(createBox("room-number", [1.18, 0.43, 0.08], panel_material, [4.63, 3.98, -4.82]));
  group.add(createBox("call-light", [0.18, 0.18, 0.08], light_material, [5.03, 3.98, -4.71]));
  group.add(createBox("wall-rail", [5.4, 0.1, 0.13], panel_material, [-2.85, 2.04, -4.79]));
  return group;
}

function createMonitorWave() {
  const points = Array.from({ length: 70 }, (_, index) => {
    const phase = index % 12;
    const y_position = phase === 0 ? 0.12 : phase === 1 ? -0.12 : phase === 2 ? 0.3 : 0;
    return new THREE.Vector3((index / 69 - 0.5) * 1.12, y_position, 0);
  });
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: COLORS.teal,
    transparent: true,
    opacity: 0.9,
  });
  const line = new THREE.Line(geometry, material);
  line.name = "monitor-waveform";
  return line;
}

function createBox(name, dimensions, material, position) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function createCylinder(name, radius_top, radius_bottom, height, material, position) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius_top, radius_bottom, height, 20),
    material,
  );
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  return mesh;
}

function createCapsule(name, radius, length, material, position) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 8, 16), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  return mesh;
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value?.isTexture) {
          value.dispose();
        }
      });
      material.dispose();
    });
  });
}
