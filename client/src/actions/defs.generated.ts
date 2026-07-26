// GENERATED FILE — edit shared/actions.json and run npm run gen:actions
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

export const ACTIONS_TICK_RATE: number = 20;

export const ACTION_DEFS: readonly ActionDef[] = [
  {
    "id": "attack_light",
    "phases": {
      "windupTicks": 5,
      "activeTicks": 2,
      "recoveryTicks": 6
    },
    "cooldownTicks": 0,
    "hold": null,
    "movement": {
      "windup": 0.4,
      "active": 0,
      "recovery": 0.6,
      "charging": 0,
      "held": 0
    },
    "canRotate": true,
    "resource": null,
    "effects": [
      {
        "kind": "melee_arc",
        "range": 2.8,
        "arcDegrees": 90,
        "damage": {
          "min": 10,
          "max": 10
        },
        "blockedDamage": {
          "min": 2,
          "max": 2
        }
      }
    ],
    "motion": "motion.act_swing_1h",
    "motionLayer": "upper",
    "interrupt": "recovery"
  },
  {
    "id": "attack_heavy",
    "phases": {
      "windupTicks": 4,
      "activeTicks": 3,
      "recoveryTicks": 10
    },
    "cooldownTicks": 20,
    "hold": {
      "mode": "charge",
      "minTicks": 6,
      "maxTicks": 30
    },
    "movement": {
      "charging": 0.3,
      "windup": 0,
      "active": 0,
      "recovery": 0.4,
      "held": 0
    },
    "canRotate": true,
    "resource": null,
    "effects": [
      {
        "kind": "melee_arc",
        "range": 3.2,
        "arcDegrees": 120,
        "damage": {
          "min": 15,
          "max": 35
        },
        "blockedDamage": {
          "min": 3,
          "max": 8
        }
      }
    ],
    "motion": "motion.act_smash_2h",
    "motionLayer": "full",
    "interrupt": "never"
  },
  {
    "id": "block",
    "phases": {
      "windupTicks": 2,
      "activeTicks": 0,
      "recoveryTicks": 4
    },
    "cooldownTicks": 0,
    "hold": {
      "mode": "sustain",
      "maxTicks": 0
    },
    "movement": {
      "windup": 0.5,
      "held": 0.5,
      "recovery": 0.5,
      "charging": 0,
      "active": 0
    },
    "canRotate": true,
    "resource": null,
    "effects": [
      {
        "kind": "mitigation",
        "multiplier": 0.2
      }
    ],
    "motion": "motion.act_guard_hold",
    "motionLayer": "upper",
    "interrupt": "always"
  },
  {
    "id": "roll",
    "phases": {
      "windupTicks": 1,
      "activeTicks": 8,
      "recoveryTicks": 3
    },
    "cooldownTicks": 24,
    "hold": null,
    "movement": {
      "windup": 0,
      "active": 0,
      "recovery": 0,
      "charging": 0,
      "held": 0
    },
    "canRotate": false,
    "resource": null,
    "effects": [
      {
        "kind": "displace_self",
        "distance": 4
      },
      {
        "kind": "invulnerable"
      }
    ],
    "motion": "motion.act_roll",
    "motionLayer": "full",
    "interrupt": "never"
  },
  {
    "id": "potion",
    "phases": {
      "windupTicks": 16,
      "activeTicks": 2,
      "recoveryTicks": 6
    },
    "cooldownTicks": 100,
    "hold": null,
    "movement": {
      "windup": 0.5,
      "active": 0.5,
      "recovery": 0.5,
      "charging": 0,
      "held": 0
    },
    "canRotate": true,
    "resource": {
      "kind": "potion_charge",
      "cost": 1
    },
    "effects": [
      {
        "kind": "heal_self",
        "amount": 30
      }
    ],
    "motion": "motion.act_drink",
    "motionLayer": "upper",
    "interrupt": "recovery"
  },
  {
    "id": "ability_bolt",
    "phases": {
      "windupTicks": 8,
      "activeTicks": 1,
      "recoveryTicks": 8
    },
    "cooldownTicks": 40,
    "hold": null,
    "movement": {
      "windup": 0.4,
      "active": 0,
      "recovery": 0.6,
      "charging": 0,
      "held": 0
    },
    "canRotate": true,
    "resource": null,
    "effects": [
      {
        "kind": "projectile",
        "speed": 18,
        "maxDistance": 30,
        "radius": 1.2,
        "damage": {
          "min": 20,
          "max": 20
        },
        "blockedDamage": {
          "min": 4,
          "max": 4
        }
      }
    ],
    "motion": "motion.act_hurl_1h",
    "motionLayer": "upper",
    "interrupt": "recovery"
  },
  {
    "id": "ability_lance",
    "phases": {
      "windupTicks": 12,
      "activeTicks": 1,
      "recoveryTicks": 10
    },
    "cooldownTicks": 80,
    "hold": null,
    "movement": {
      "windup": 0,
      "active": 0,
      "recovery": 0.4,
      "charging": 0,
      "held": 0
    },
    "canRotate": true,
    "resource": null,
    "effects": [
      {
        "kind": "projectile",
        "speed": 30,
        "maxDistance": 45,
        "radius": 0.8,
        "damage": {
          "min": 30,
          "max": 30
        },
        "blockedDamage": {
          "min": 6,
          "max": 6
        }
      }
    ],
    "motion": "motion.act_hurl_1h",
    "motionLayer": "upper",
    "interrupt": "never"
  },
  {
    "id": "ability_nova",
    "phases": {
      "windupTicks": 10,
      "activeTicks": 2,
      "recoveryTicks": 12
    },
    "cooldownTicks": 120,
    "hold": null,
    "movement": {
      "windup": 0,
      "active": 0,
      "recovery": 0,
      "charging": 0,
      "held": 0
    },
    "canRotate": false,
    "resource": null,
    "effects": [
      {
        "kind": "aoe_at_target",
        "radius": 5,
        "maxRange": 0,
        "damage": {
          "min": 25,
          "max": 25
        },
        "blockedDamage": {
          "min": 8,
          "max": 8
        }
      }
    ],
    "motion": "motion.act_slam_2h",
    "motionLayer": "full",
    "interrupt": "never"
  },
  {
    "id": "ability_quake",
    "phases": {
      "windupTicks": 14,
      "activeTicks": 2,
      "recoveryTicks": 10
    },
    "cooldownTicks": 100,
    "hold": null,
    "movement": {
      "windup": 0,
      "active": 0,
      "recovery": 0.4,
      "charging": 0,
      "held": 0
    },
    "canRotate": true,
    "resource": null,
    "effects": [
      {
        "kind": "aoe_at_target",
        "radius": 3.5,
        "maxRange": 18,
        "damage": {
          "min": 22,
          "max": 22
        },
        "blockedDamage": {
          "min": 6,
          "max": 6
        }
      }
    ],
    "motion": "motion.act_slam_2h",
    "motionLayer": "full",
    "interrupt": "recovery"
  },
  {
    "id": "ability_mend",
    "phases": {
      "windupTicks": 20,
      "activeTicks": 2,
      "recoveryTicks": 8
    },
    "cooldownTicks": 200,
    "hold": null,
    "movement": {
      "windup": 0.3,
      "active": 0,
      "recovery": 0.5,
      "charging": 0,
      "held": 0
    },
    "canRotate": true,
    "resource": null,
    "effects": [
      {
        "kind": "heal_self",
        "amount": 20
      }
    ],
    "motion": "motion.act_drink",
    "motionLayer": "upper",
    "interrupt": "recovery"
  }
] as const;

export const SLOT_BINDINGS: readonly SlotBinding[] = [
  {
    "slot": "primary",
    "tapAction": "attack_light",
    "holdAction": "attack_heavy",
    "holdThresholdTicks": 5
  },
  {
    "slot": "block",
    "tapAction": null,
    "holdAction": "block",
    "holdThresholdTicks": 0
  },
  {
    "slot": "roll",
    "tapAction": "roll",
    "holdAction": null,
    "holdThresholdTicks": 0
  },
  {
    "slot": "potion",
    "tapAction": "potion",
    "holdAction": null,
    "holdThresholdTicks": 0
  },
  {
    "slot": "ability1",
    "tapAction": "ability_bolt",
    "holdAction": null,
    "holdThresholdTicks": 0
  },
  {
    "slot": "ability2",
    "tapAction": "ability_lance",
    "holdAction": null,
    "holdThresholdTicks": 0
  },
  {
    "slot": "ability3",
    "tapAction": "ability_nova",
    "holdAction": null,
    "holdThresholdTicks": 0
  },
  {
    "slot": "ability4",
    "tapAction": "ability_quake",
    "holdAction": null,
    "holdThresholdTicks": 0
  },
  {
    "slot": "ability5",
    "tapAction": "ability_mend",
    "holdAction": null,
    "holdThresholdTicks": 0
  }
] as const;

export const RESOURCE_DEFS: readonly ResourceDef[] = [
  {
    "kind": "potion_charge",
    "max": 3,
    "onRespawn": 3
  }
] as const;
