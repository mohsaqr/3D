import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project_root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const avatar_path = path.join(project_root, "public", "avatars", "avatarsdk.glb");
const notice_path = path.join(project_root, "THIRD_PARTY_NOTICES.md");
const license_path = path.join(
  project_root,
  "public",
  "licenses",
  "talkinghead.LICENSE.txt",
);

const GLB_MAGIC = "glTF";
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;

function parse_glb(file_path) {
  const buffer = readFileSync(file_path);

  assert.ok(buffer.length >= 20, "GLB contains a header and JSON chunk header");
  assert.equal(buffer.toString("ascii", 0, 4), GLB_MAGIC, "GLB magic is valid");
  assert.equal(buffer.readUInt32LE(4), GLB_VERSION, "asset uses glTF 2.0");
  assert.equal(buffer.readUInt32LE(8), buffer.length, "declared GLB length is exact");

  const chunks = [];
  let offset = 12;

  while (offset < buffer.length) {
    assert.ok(offset + 8 <= buffer.length, "chunk header is within the GLB");

    const byte_length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + byte_length;

    assert.equal(byte_length % 4, 0, "chunk length is four-byte aligned");
    assert.ok(end <= buffer.length, "chunk payload is within the GLB");
    chunks.push({ type, data: buffer.subarray(start, end) });
    offset = end;
  }

  assert.equal(offset, buffer.length, "chunks consume the complete GLB");
  assert.equal(chunks[0]?.type, JSON_CHUNK_TYPE, "first chunk is JSON");
  assert.equal(chunks[1]?.type, BIN_CHUNK_TYPE, "second chunk is binary data");

  const document = JSON.parse(chunks[0].data.toString("utf8").trimEnd());
  return { buffer, chunks, document };
}

function get_mesh(document, name) {
  return document.meshes.find((mesh) => mesh.name === name);
}

test("AvatarSDK GLB is a complete, realistically scaled, skinned patient", () => {
  assert.equal(existsSync(avatar_path), true, "patient avatar asset exists");

  const { chunks, document } = parse_glb(avatar_path);
  assert.equal(document.asset.version, "2.0");
  assert.ok(document.scenes.length >= 1, "asset contains a scene");
  assert.equal(document.buffers.length, 1, "asset has one embedded binary buffer");
  assert.ok(
    chunks[1].data.length >= document.buffers[0].byteLength,
    "binary chunk contains the declared buffer",
  );

  const skin = document.skins.find((candidate) => candidate.name === "Armature");
  assert.ok(skin, "Armature skin exists");
  assert.ok(skin.joints.length >= 70, "skin contains a detailed full-body rig");
  assert.ok(
    Number.isInteger(skin.inverseBindMatrices),
    "skin supplies inverse bind matrices",
  );

  const joint_names = new Set(
    skin.joints.map((node_index) => document.nodes[node_index]?.name),
  );
  const required_joints = [
    "Hips",
    "Spine",
    "Spine1",
    "Head",
    "LeftArm",
    "RightArm",
    "LeftForeArm",
    "RightForeArm",
    "LeftHand",
    "RightHand",
    "LeftUpLeg",
    "RightUpLeg",
    "LeftLeg",
    "RightLeg",
    "LeftFoot",
    "RightFoot",
  ];
  required_joints.forEach((joint_name) => {
    assert.ok(joint_names.has(joint_name), `${joint_name} is a skinned body joint`);
  });

  const required_mesh_names = [
    "AvatarBody",
    "AvatarHead",
    "outfit_top",
    "outfit_bottom",
    "outfit_shoes",
  ];
  required_mesh_names.forEach((mesh_name) => {
    const mesh_index = document.meshes.findIndex((mesh) => mesh.name === mesh_name);
    assert.ok(mesh_index >= 0, `${mesh_name} mesh exists`);

    const mesh_node = document.nodes.find((node) => node.mesh === mesh_index);
    assert.ok(mesh_node, `${mesh_name} is attached to a scene node`);
    assert.equal(document.skins[mesh_node.skin], skin, `${mesh_name} uses the body skin`);
  });

  const position_bounds = document.meshes.map((mesh) => {
    const position_accessor_index = mesh.primitives[0]?.attributes?.POSITION;
    const accessor = document.accessors[position_accessor_index];

    assert.ok(accessor?.min && accessor?.max, `${mesh.name} has position bounds`);
    return { min_y: accessor.min[1], max_y: accessor.max[1] };
  });
  const min_y = Math.min(...position_bounds.map((bounds) => bounds.min_y));
  const max_y = Math.max(...position_bounds.map((bounds) => bounds.max_y));
  const vertical_extent_m = max_y - min_y;

  assert.ok(min_y <= 0.05, "geometry reaches floor level");
  assert.ok(max_y >= 1.6, "geometry reaches an adult head height");
  assert.ok(
    vertical_extent_m >= 1.5 && vertical_extent_m <= 2.2,
    `full-body vertical extent is realistic (${vertical_extent_m.toFixed(3)} m)`,
  );
});

test("AvatarSDK head includes blink and speech morph targets", () => {
  const { document } = parse_glb(avatar_path);
  const head_mesh = get_mesh(document, "AvatarHead");
  const morph_names = head_mesh?.extras?.targetNames;

  assert.ok(head_mesh, "head mesh exists");
  assert.ok(Array.isArray(morph_names), "head exposes named facial morph targets");
  assert.equal(
    head_mesh.primitives[0].targets.length,
    morph_names.length,
    "every named head morph has target geometry",
  );
  assert.ok(morph_names.includes("eyeBlinkLeft"), "left blink morph exists");
  assert.ok(morph_names.includes("eyeBlinkRight"), "right blink morph exists");

  const viseme_names = morph_names.filter((name) => name.startsWith("viseme_"));
  assert.ok(viseme_names.length >= 15, "head has a complete speech viseme set");
  ["viseme_PP", "viseme_aa", "viseme_O", "viseme_sil"].forEach((viseme_name) => {
    assert.ok(viseme_names.includes(viseme_name), `${viseme_name} exists`);
  });
});

test("TalkingHead avatar attribution and license are retained", () => {
  assert.equal(existsSync(notice_path), true, "THIRD_PARTY_NOTICES.md exists");
  assert.equal(existsSync(license_path), true, "TalkingHead license exists");

  const notice = readFileSync(notice_path, "utf8");
  const license = readFileSync(license_path, "utf8");

  assert.match(notice, /TalkingHead example avatar/i);
  assert.match(notice, /public\/avatars\/avatarsdk\.glb/);
  assert.match(notice, /github\.com\/met4citizen\/TalkingHead/);
  assert.match(notice, /public\/licenses\/talkinghead\.LICENSE\.txt/);
  assert.match(notice, /MIT License/i);
  assert.match(license, /^MIT License/m);
  assert.match(license, /Copyright \(c\) 2023-2024 Mika Suominen/);
  assert.match(license, /Permission is hereby granted, free of charge/);
});
