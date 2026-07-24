/**
 * Content seam — public API.
 *
 * Game code imports from here and refers to content by logical key. It never
 * imports a loader, a file path, or a procedural generator directly.
 */

export {
  ALL_MOTION_KEYS,
  ALL_PROP_KEYS,
  BODY_KEYS,
  MOTION_ACTION,
  MOTION_AIR,
  MOTION_KEYS,
  MOTION_LOCOMOTION,
  MOTION_REACTION,
  MOTION_STANCE,
  motionIdFromKey,
  PROP_KEYS,
  type BodyKey,
  type MotionKey,
  type PropKey,
} from './keys';

export {
  ALL_STANCE_KEYS,
  STANCE_KEYS,
  STANCES,
  type Stance,
  type StanceKey,
  type StanceSlot,
} from './stances';
export { applyGrip, gripFor, SOCKETS, type Grip, type SocketId } from './sockets';

export { bindingFor, contentSeamReport, CONTENT_MANIFEST } from './manifest';
export {
  describeClipBinding,
  describeRigBinding,
  inspectClipBinding,
  inspectRigBinding,
  type ClipBindingReport,
  type RigBindingReport,
} from './inspect';
export { resolveBody, resolveMotion, resolveProp } from './resolve';
export { MOG_BONE_ORDER, MOG_REST_POSE } from './restPose';
export {
  registerBodyGenerator,
  registerMotionGenerator,
  registerPropGenerator,
  registeredGeneratorIds,
} from './registry';
export type {
  BodyGenerator,
  ContentBinding,
  ContentBindingOrigin,
  ContentKey,
  ContentSource,
  MotionGenerator,
  MotionGeneratorContext,
  PropGenerator,
  ResolvedBody,
  RestPose,
} from './types';
