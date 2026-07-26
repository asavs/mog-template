/**
 * Generate typed Rust and TypeScript action definitions from shared/actions.json.
 *
 * Usage: node tools/gen-actions/gen.mjs
 *        node tools/gen-actions/gen.mjs --check   # exit 1 if generated files are stale
 *
 * This generator intentionally has zero npm dependencies so it can run before
 * package installation. JSON array and object order is preserved as authored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const JSON_PATH = path.join(ROOT, 'shared', 'actions.json');
const RUST_OUT = path.join(
  ROOT,
  'server',
  'spacetimedb',
  'src',
  'actions',
  'defs.generated.rs',
);
const TS_OUT = path.join(ROOT, 'client', 'src', 'actions', 'defs.generated.ts');

const UINT32_MAX = 4_294_967_295;
const MOTION_PATTERN = /^motion\.[a-z0-9]+_[a-z0-9_]+$/;
const MOVEMENT_FIELDS = ['charging', 'windup', 'active', 'held', 'recovery'];
const ACTION_FIELDS = [
  'id',
  'phases',
  'cooldownTicks',
  'hold',
  'movement',
  'canRotate',
  'resource',
  'effects',
  'motion',
  'motionLayer',
  'interrupt',
];
const SLOT_FIELDS = ['slot', 'tapAction', 'holdAction', 'holdThresholdTicks'];
const RESOURCE_FIELDS = ['kind', 'max', 'onRespawn'];

const EFFECT_FIELDS = {
  melee_arc: [
    ['range', 'scalar'],
    ['arcDegrees', 'scalar'],
    ['damage', 'scaled'],
    ['blockedDamage', 'scaled'],
  ],
  projectile: [
    ['speed', 'scalar'],
    ['maxDistance', 'scalar'],
    ['radius', 'scalar'],
    ['damage', 'scaled'],
    ['blockedDamage', 'scaled'],
  ],
  aoe_at_target: [
    ['radius', 'scalar'],
    ['maxRange', 'scalar'],
    ['damage', 'scaled'],
    ['blockedDamage', 'scaled'],
  ],
  heal_self: [['amount', 'scalar']],
  displace_self: [['distance', 'scalar']],
  invulnerable: [],
  mitigation: [['multiplier', 'scalar']],
};

const RUST_FIELD_NAMES = {
  windupTicks: 'windup_ticks',
  activeTicks: 'active_ticks',
  recoveryTicks: 'recovery_ticks',
  minTicks: 'min_ticks',
  maxTicks: 'max_ticks',
  arcDegrees: 'arc_degrees',
  maxDistance: 'max_distance',
  blockedDamage: 'blocked_damage',
  maxRange: 'max_range',
  cooldownTicks: 'cooldown_ticks',
  canRotate: 'can_rotate',
  motionLayer: 'motion_layer',
  tapAction: 'tap_action',
  holdAction: 'hold_action',
  holdThresholdTicks: 'hold_threshold_ticks',
  onRespawn: 'on_respawn',
};

function readAuthority() {
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function actionLabel(action, index) {
  return typeof action?.id === 'string'
    ? `action "${action.id}"`
    : `action "<missing:${index}>"`;
}

function slotLabel(slot, index) {
  return typeof slot?.slot === 'string' ? `slot "${slot.slot}"` : `slot "<missing:${index}>"`;
}

function resourceLabel(resource, index) {
  return typeof resource?.kind === 'string'
    ? `resource "${resource.kind}"`
    : `resource "<missing:${index}>"`;
}

function validateKnownFields(value, allowedFields, label, errors) {
  if (!isRecord(value)) return;
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label} field "${field}" is not allowed`);
  }
}

function validateString(value, label, errors) {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
  }
}

function validateU32(value, label, errors) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    errors.push(`${label} must be a non-negative integer representable as u32`);
  }
}

function validateScalar(value, label, errors) {
  if (!isFiniteNumber(value)) errors.push(`${label} must be a finite number scalar`);
}

function validateScaledValue(value, label, errors) {
  if (!Array.isArray(value)) {
    if (!isFiniteNumber(value)) {
      errors.push(`${label} must be a finite number or a 2-element [min, max] array`);
    }
    return;
  }
  if (value.length !== 2 || !value.every(isFiniteNumber)) {
    errors.push(`${label} must be a 2-element [min, max] array of finite numbers`);
    return;
  }
  if (value[0] > value[1]) {
    errors.push(`${label} has min ${value[0]} greater than max ${value[1]}`);
  }
}

function validatePhases(phases, label, errors) {
  if (!isRecord(phases)) {
    errors.push(`${label} field "phases" must be an object`);
    return;
  }
  validateKnownFields(
    phases,
    ['windupTicks', 'activeTicks', 'recoveryTicks'],
    `${label} phases`,
    errors,
  );
  for (const field of ['windupTicks', 'activeTicks', 'recoveryTicks']) {
    validateU32(phases[field], `${label} field "phases.${field}"`, errors);
  }
}

function validateHold(hold, label, errors) {
  if (hold === null) return;
  if (!isRecord(hold)) {
    errors.push(`${label} field "hold" must be null or an object`);
    return;
  }
  if (hold.mode !== 'charge' && hold.mode !== 'sustain') {
    errors.push(`${label} field "hold.mode" must be exactly "charge" or "sustain"`);
    return;
  }

  const allowedFields =
    hold.mode === 'charge' ? ['mode', 'minTicks', 'maxTicks'] : ['mode', 'maxTicks'];
  validateKnownFields(hold, allowedFields, `${label} hold`, errors);
  if (hold.mode === 'charge') {
    validateU32(hold.minTicks, `${label} field "hold.minTicks"`, errors);
    validateU32(hold.maxTicks, `${label} field "hold.maxTicks"`, errors);
    if (
      Number.isInteger(hold.minTicks) &&
      Number.isInteger(hold.maxTicks) &&
      hold.minTicks > hold.maxTicks
    ) {
      errors.push(`${label} field "hold.minTicks" must be <= "hold.maxTicks"`);
    }
  } else {
    validateU32(hold.maxTicks, `${label} field "hold.maxTicks"`, errors);
    if (hold.maxTicks !== 0) {
      errors.push(`${label} field "hold.maxTicks" must be 0 for sustain mode`);
    }
  }
}

function validateMovement(movement, label, errors) {
  if (!isRecord(movement)) {
    errors.push(`${label} field "movement" must be an object`);
    return;
  }
  validateKnownFields(movement, MOVEMENT_FIELDS, `${label} movement`, errors);
  for (const [field, value] of Object.entries(movement)) {
    if (!MOVEMENT_FIELDS.includes(field)) continue;
    if (!isFiniteNumber(value) || value < 0 || value > 1) {
      errors.push(`${label} field "movement.${field}" must be a number from 0 to 1`);
    }
  }
}

function validateActionResource(resource, label, errors) {
  if (resource === null) return;
  if (!isRecord(resource)) {
    errors.push(`${label} field "resource" must be null or an object`);
    return;
  }
  validateKnownFields(resource, ['kind', 'cost'], `${label} resource`, errors);
  validateString(resource.kind, `${label} field "resource.kind"`, errors);
  validateU32(resource.cost, `${label} field "resource.cost"`, errors);
}

function validateEffect(effect, action, actionIndex, effectIndex, errors) {
  const label = actionLabel(action, actionIndex);
  const fieldLabel = `${label} field "effects[${effectIndex}]"`;
  if (!isRecord(effect)) {
    errors.push(`${fieldLabel} must be an object`);
    return;
  }

  const schema = EFFECT_FIELDS[effect.kind];
  if (!schema) {
    errors.push(
      `${label} field "effects[${effectIndex}].kind" must be one of ${Object.keys(EFFECT_FIELDS)
        .map((kind) => `"${kind}"`)
        .join(', ')}`,
    );
    for (const field of ['damage', 'blockedDamage']) {
      if (field in effect) {
        validateScaledValue(
          effect[field],
          `${label} field "effects[${effectIndex}].${field}"`,
          errors,
        );
      }
    }
    return;
  }

  validateKnownFields(
    effect,
    ['kind', ...schema.map(([field]) => field)],
    `${label} effect "${effect.kind}" at index ${effectIndex}`,
    errors,
  );
  for (const [field, fieldType] of schema) {
    const valueLabel = `${label} field "effects[${effectIndex}].${field}"`;
    if (fieldType === 'scaled') validateScaledValue(effect[field], valueLabel, errors);
    else validateScalar(effect[field], valueLabel, errors);
  }
}

function validateAction(action, index, errors) {
  const label = actionLabel(action, index);
  if (!isRecord(action)) {
    errors.push(`${label} must be an object`);
    return;
  }

  validateKnownFields(action, ACTION_FIELDS, label, errors);
  validateString(action.id, `${label} field "id"`, errors);
  validatePhases(action.phases, label, errors);
  validateU32(action.cooldownTicks, `${label} field "cooldownTicks"`, errors);
  validateHold(action.hold, label, errors);
  validateMovement(action.movement, label, errors);
  if (typeof action.canRotate !== 'boolean') {
    errors.push(`${label} field "canRotate" must be a boolean`);
  }
  validateActionResource(action.resource, label, errors);

  if (!Array.isArray(action.effects)) {
    errors.push(`${label} field "effects" must be an array`);
  } else {
    action.effects.forEach((effect, effectIndex) =>
      validateEffect(effect, action, index, effectIndex, errors),
    );
  }

  if (typeof action.motion !== 'string' || !MOTION_PATTERN.test(action.motion)) {
    errors.push(`${label} field "motion" must match ^motion\\.[a-z0-9]+_[a-z0-9_]+$`);
  }
  if (action.motionLayer !== 'upper' && action.motionLayer !== 'full') {
    errors.push(`${label} field "motionLayer" must be exactly "upper" or "full"`);
  }
  if (!['never', 'recovery', 'always'].includes(action.interrupt)) {
    errors.push(
      `${label} field "interrupt" must be exactly "never", "recovery", or "always"`,
    );
  }
}

function validateSlot(slot, index, actionIds, errors) {
  const label = slotLabel(slot, index);
  if (!isRecord(slot)) {
    errors.push(`${label} must be an object`);
    return;
  }
  validateKnownFields(slot, SLOT_FIELDS, label, errors);
  validateString(slot.slot, `${label} field "slot"`, errors);
  for (const field of ['tapAction', 'holdAction']) {
    const actionId = slot[field];
    if (actionId !== null && typeof actionId !== 'string') {
      errors.push(`${label} field "${field}" must be an action id string or null`);
    } else if (typeof actionId === 'string' && !actionIds.has(actionId)) {
      errors.push(`${label} field "${field}" references unknown action "${actionId}"`);
    }
  }
  validateU32(slot.holdThresholdTicks, `${label} field "holdThresholdTicks"`, errors);
}

function validateResource(resource, index, errors) {
  const label = resourceLabel(resource, index);
  if (!isRecord(resource)) {
    errors.push(`${label} must be an object`);
    return;
  }
  validateKnownFields(resource, RESOURCE_FIELDS, label, errors);
  validateString(resource.kind, `${label} field "kind"`, errors);
  validateU32(resource.max, `${label} field "max"`, errors);
  validateU32(resource.onRespawn, `${label} field "onRespawn"`, errors);
}

function validateAuthority(data) {
  const errors = [];
  if (!isRecord(data)) {
    throw new Error('[gen-actions] authority validation failed:\n- top-level value must be an object');
  }

  if (!isFiniteNumber(data.tickRate) || data.tickRate <= 0) {
    errors.push('top-level field "tickRate" must be a positive number');
  } else if (!Number.isInteger(data.tickRate) || data.tickRate > UINT32_MAX) {
    errors.push('top-level field "tickRate" must be a positive integer representable as u32');
  }

  const actions = Array.isArray(data.actions) ? data.actions : [];
  if (!Array.isArray(data.actions)) errors.push('top-level field "actions" must be an array');

  const actionIds = new Set();
  const firstActionIndex = new Map();
  actions.forEach((action, index) => {
    validateAction(action, index, errors);
    if (typeof action?.id !== 'string') return;
    if (actionIds.has(action.id)) {
      errors.push(
        `${actionLabel(action, index)} field "id" duplicates actions[${firstActionIndex.get(action.id)}].id`,
      );
    } else {
      actionIds.add(action.id);
      firstActionIndex.set(action.id, index);
    }
  });

  if (!Array.isArray(data.slots)) {
    errors.push('top-level field "slots" must be an array');
  } else {
    data.slots.forEach((slot, index) => validateSlot(slot, index, actionIds, errors));
  }

  if (!Array.isArray(data.resources)) {
    errors.push('top-level field "resources" must be an array');
  } else {
    data.resources.forEach((resource, index) => validateResource(resource, index, errors));
  }

  if (errors.length) {
    throw new Error(`[gen-actions] authority validation failed:\n- ${errors.join('\n- ')}`);
  }
}

function normalizeScaledValue(value) {
  return Array.isArray(value)
    ? { min: value[0], max: value[1] }
    : { min: value, max: value };
}

function normalizeMovement(movement) {
  const normalized = {};
  for (const [field, value] of Object.entries(movement)) normalized[field] = value;
  for (const field of MOVEMENT_FIELDS) {
    if (!(field in normalized)) normalized[field] = 0;
  }
  return normalized;
}

function normalizeEffect(effect) {
  const normalized = {};
  for (const [field, value] of Object.entries(effect)) {
    normalized[field] =
      field === 'damage' || field === 'blockedDamage'
        ? normalizeScaledValue(value)
        : value;
  }
  return normalized;
}

function normalizeAction(action) {
  const normalized = {};
  for (const [field, value] of Object.entries(action)) {
    if (field === 'movement') normalized[field] = normalizeMovement(value);
    else if (field === 'effects') normalized[field] = value.map(normalizeEffect);
    else normalized[field] = value;
  }
  return normalized;
}

function normalizeAuthority(data) {
  return {
    tickRate: data.tickRate,
    resources: data.resources.map((resource) => ({ ...resource })),
    actions: data.actions.map(normalizeAction),
    slots: data.slots.map((slot) => ({ ...slot })),
  };
}

function rustString(value) {
  return JSON.stringify(value);
}

function rustFloat(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function rustFieldName(field) {
  return RUST_FIELD_NAMES[field] ?? field;
}

function rustStructValue(typeName, value, formatValue) {
  const fields = Object.entries(value)
    .map(([field, fieldValue]) => `${rustFieldName(field)}: ${formatValue(field, fieldValue)}`)
    .join(', ');
  return `${typeName} { ${fields} }`;
}

function rustScaledValue(value) {
  return rustStructValue('ScaledValue', value, (_field, fieldValue) => rustFloat(fieldValue));
}

function rustPhases(phases) {
  return rustStructValue('PhaseDurations', phases, (_field, value) => String(value));
}

function rustHold(hold) {
  if (hold === null) return 'None';
  if (hold.mode === 'charge') {
    return `Some(HoldSpec::Charge { min_ticks: ${hold.minTicks}, max_ticks: ${hold.maxTicks} })`;
  }
  return `Some(HoldSpec::Sustain { max_ticks: ${hold.maxTicks} })`;
}

function rustMovement(movement) {
  return rustStructValue('MovementFractions', movement, (_field, value) => rustFloat(value));
}

function rustResourceCost(resource) {
  if (resource === null) return 'None';
  const value = rustStructValue('ActionResourceCost', resource, (field, fieldValue) =>
    field === 'kind' ? rustString(fieldValue) : String(fieldValue),
  );
  return `Some(${value})`;
}

function rustEffect(effect) {
  const variants = {
    melee_arc: 'MeleeArc',
    projectile: 'Projectile',
    aoe_at_target: 'AoeAtTarget',
    heal_self: 'HealSelf',
    displace_self: 'DisplaceSelf',
    invulnerable: 'Invulnerable',
    mitigation: 'Mitigation',
  };
  const variant = variants[effect.kind];
  const fields = Object.entries(effect).filter(([field]) => field !== 'kind');
  if (fields.length === 0) return `EffectDef::${variant}`;

  const body = fields
    .map(([field, value]) => {
      const formatted =
        field === 'damage' || field === 'blockedDamage'
          ? rustScaledValue(value)
          : rustFloat(value);
      return `${rustFieldName(field)}: ${formatted}`;
    })
    .join(', ');
  return `EffectDef::${variant} { ${body} }`;
}

function rustMotionLayer(value) {
  return value === 'upper' ? 'MotionLayer::Upper' : 'MotionLayer::Full';
}

function rustInterrupt(value) {
  const variants = { never: 'Never', recovery: 'Recovery', always: 'Always' };
  return `InterruptPolicy::${variants[value]}`;
}

function pushAction(lines, action) {
  lines.push('    ActionDef {');
  for (const [field, value] of Object.entries(action)) {
    if (field === 'effects') {
      lines.push('        effects: &[');
      for (const effect of value) lines.push(`            ${rustEffect(effect)},`);
      lines.push('        ],');
      continue;
    }

    const formatters = {
      id: rustString,
      phases: rustPhases,
      cooldownTicks: String,
      hold: rustHold,
      movement: rustMovement,
      canRotate: String,
      resource: rustResourceCost,
      motion: rustString,
      motionLayer: rustMotionLayer,
      interrupt: rustInterrupt,
    };
    lines.push(`        ${rustFieldName(field)}: ${formatters[field](value)},`);
  }
  lines.push('    },');
}

function pushSlot(lines, slot) {
  lines.push('    SlotBinding {');
  for (const [field, value] of Object.entries(slot)) {
    let formatted;
    if (field === 'tapAction' || field === 'holdAction') {
      formatted = value === null ? 'None' : `Some(${rustString(value)})`;
    } else if (field === 'slot') formatted = rustString(value);
    else formatted = String(value);
    lines.push(`        ${rustFieldName(field)}: ${formatted},`);
  }
  lines.push('    },');
}

function pushResource(lines, resource) {
  lines.push('    ResourceDef {');
  for (const [field, value] of Object.entries(resource)) {
    const formatted = field === 'kind' ? rustString(value) : String(value);
    lines.push(`        ${rustFieldName(field)}: ${formatted},`);
  }
  lines.push('    },');
}

function generateRust(data) {
  const lines = [
    '// GENERATED FILE — edit shared/actions.json and run npm run gen:actions',
    '// Source: shared/actions.json',
    '',
    '#![allow(dead_code)]',
    '',
    'pub struct ScaledValue {',
    '    pub min: f32,',
    '    pub max: f32,',
    '}',
    '',
    'pub struct PhaseDurations {',
    '    pub windup_ticks: u32,',
    '    pub active_ticks: u32,',
    '    pub recovery_ticks: u32,',
    '}',
    '',
    'pub enum HoldSpec {',
    '    Charge { min_ticks: u32, max_ticks: u32 },',
    '    Sustain { max_ticks: u32 },',
    '}',
    '',
    'pub struct MovementFractions {',
    '    pub charging: f32,',
    '    pub windup: f32,',
    '    pub active: f32,',
    '    pub held: f32,',
    '    pub recovery: f32,',
    '}',
    '',
    'pub enum EffectDef {',
    '    MeleeArc {',
    '        range: f32,',
    '        arc_degrees: f32,',
    '        damage: ScaledValue,',
    '        blocked_damage: ScaledValue,',
    '    },',
    '    Projectile {',
    '        speed: f32,',
    '        max_distance: f32,',
    '        radius: f32,',
    '        damage: ScaledValue,',
    '        blocked_damage: ScaledValue,',
    '    },',
    '    AoeAtTarget {',
    '        radius: f32,',
    '        max_range: f32,',
    '        damage: ScaledValue,',
    '        blocked_damage: ScaledValue,',
    '    },',
    '    HealSelf { amount: f32 },',
    '    DisplaceSelf { distance: f32 },',
    '    Invulnerable,',
    '    Mitigation { multiplier: f32 },',
    '}',
    '',
    'pub enum MotionLayer {',
    '    Upper,',
    '    Full,',
    '}',
    '',
    'pub enum InterruptPolicy {',
    '    Never,',
    '    Recovery,',
    '    Always,',
    '}',
    '',
    'pub struct ActionResourceCost {',
    "    pub kind: &'static str,",
    '    pub cost: u32,',
    '}',
    '',
    'pub struct ActionDef {',
    "    pub id: &'static str,",
    '    pub phases: PhaseDurations,',
    '    pub cooldown_ticks: u32,',
    '    pub hold: Option<HoldSpec>,',
    '    pub movement: MovementFractions,',
    '    pub can_rotate: bool,',
    '    pub resource: Option<ActionResourceCost>,',
    "    pub effects: &'static [EffectDef],",
    "    pub motion: &'static str,",
    '    pub motion_layer: MotionLayer,',
    '    pub interrupt: InterruptPolicy,',
    '}',
    '',
    'pub struct SlotBinding {',
    "    pub slot: &'static str,",
    "    pub tap_action: Option<&'static str>,",
    "    pub hold_action: Option<&'static str>,",
    '    pub hold_threshold_ticks: u32,',
    '}',
    '',
    'pub struct ResourceDef {',
    "    pub kind: &'static str,",
    '    pub max: u32,',
    '    pub on_respawn: u32,',
    '}',
    '',
    `pub const ACTIONS_TICK_RATE: u32 = ${data.tickRate};`,
    '',
    'pub const ACTION_DEFS: &[ActionDef] = &[',
  ];

  for (const action of data.actions) pushAction(lines, action);
  lines.push('];', '', 'pub const SLOT_BINDINGS: &[SlotBinding] = &[');
  for (const slot of data.slots) pushSlot(lines, slot);
  lines.push('];', '', 'pub const RESOURCE_DEFS: &[ResourceDef] = &[');
  for (const resource of data.resources) pushResource(lines, resource);
  lines.push('];', '');
  return `${lines.join('\n')}\n`;
}

function generateTs(data) {
  return `// GENERATED FILE — edit shared/actions.json and run npm run gen:actions
// Source: shared/actions.json

export interface ScaledValue {
  min: number;
  max: number;
}

export interface PhaseDurations {
  windupTicks: number;
  activeTicks: number;
  recoveryTicks: number;
}

export interface MovementFractions {
  charging: number;
  windup: number;
  active: number;
  held: number;
  recovery: number;
}

export type HoldSpec =
  | { mode: 'charge'; minTicks: number; maxTicks: number }
  | { mode: 'sustain'; maxTicks: number };

export type EffectDef =
  | {
      kind: 'melee_arc';
      range: number;
      arcDegrees: number;
      damage: ScaledValue;
      blockedDamage: ScaledValue;
    }
  | {
      kind: 'projectile';
      speed: number;
      maxDistance: number;
      radius: number;
      damage: ScaledValue;
      blockedDamage: ScaledValue;
    }
  | {
      kind: 'aoe_at_target';
      radius: number;
      maxRange: number;
      damage: ScaledValue;
      blockedDamage: ScaledValue;
    }
  | { kind: 'heal_self'; amount: number }
  | { kind: 'displace_self'; distance: number }
  | { kind: 'invulnerable' }
  | { kind: 'mitigation'; multiplier: number };

export type MotionLayer = 'upper' | 'full';
export type InterruptPolicy = 'never' | 'recovery' | 'always';

export interface ActionResourceCost {
  kind: string;
  cost: number;
}

export interface ActionDef {
  id: string;
  phases: PhaseDurations;
  cooldownTicks: number;
  hold: HoldSpec | null;
  movement: MovementFractions;
  canRotate: boolean;
  resource: ActionResourceCost | null;
  effects: readonly EffectDef[];
  motion: string;
  motionLayer: MotionLayer;
  interrupt: InterruptPolicy;
}

export interface SlotBinding {
  slot: string;
  tapAction: string | null;
  holdAction: string | null;
  holdThresholdTicks: number;
}

export interface ResourceDef {
  kind: string;
  max: number;
  onRespawn: number;
}

export const ACTIONS_TICK_RATE: number = ${data.tickRate};

export const ACTION_DEFS: readonly ActionDef[] = ${JSON.stringify(data.actions, null, 2)} as const;

export const SLOT_BINDINGS: readonly SlotBinding[] = ${JSON.stringify(data.slots, null, 2)} as const;

export const RESOURCE_DEFS: readonly ResourceDef[] = ${JSON.stringify(data.resources, null, 2)} as const;
`;
}

function main() {
  const check = process.argv.includes('--check');
  const authority = readAuthority();
  validateAuthority(authority);
  const data = normalizeAuthority(authority);
  const rust = generateRust(data);
  const ts = generateTs(data);

  if (check) {
    const existingRust = fs.existsSync(RUST_OUT) ? fs.readFileSync(RUST_OUT, 'utf8') : '';
    const existingTs = fs.existsSync(TS_OUT) ? fs.readFileSync(TS_OUT, 'utf8') : '';
    if (existingRust !== rust || existingTs !== ts) {
      console.error(
        '[gen-actions] generated files are stale. Run: node tools/gen-actions/gen.mjs',
      );
      process.exit(1);
    }
    console.log('[gen-actions] generated files up to date');
    return;
  }

  fs.mkdirSync(path.dirname(RUST_OUT), { recursive: true });
  fs.mkdirSync(path.dirname(TS_OUT), { recursive: true });
  fs.writeFileSync(RUST_OUT, rust);
  fs.writeFileSync(TS_OUT, ts);
  console.log(`[gen-actions] wrote ${path.relative(ROOT, RUST_OUT)}`);
  console.log(`[gen-actions] wrote ${path.relative(ROOT, TS_OUT)}`);
}

main();
