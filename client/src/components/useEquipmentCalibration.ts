import { useEffect, type MutableRefObject } from 'react';
import * as THREE from 'three';

type EquipmentCalibrationState = {
  enabled: boolean;
  selectedItem: string;
};

declare global {
  interface Window {
    __equipmentCalibrationDebug?: EquipmentCalibrationState;
    enableEquipmentCalibration?: (selectedItem?: string) => void;
    disableEquipmentCalibration?: () => void;
    selectEquipmentCalibrationItem?: (selectedItem: string) => void;
  }
}

type EquipmentCalibrationOptions = {
  enabled: boolean;
  equipmentItemsRef: MutableRefObject<Map<string, THREE.Object3D>>;
};

export function useEquipmentCalibration({
  enabled,
  equipmentItemsRef,
}: EquipmentCalibrationOptions) {
  useEffect(() => {
    if (!enabled) return;

    const calibrationState = getEquipmentCalibrationState();
    window.enableEquipmentCalibration = (selectedItem = calibrationState.selectedItem) => {
      calibrationState.enabled = true;
      calibrationState.selectedItem = selectedItem;
      console.log(`[EquipmentCalibration] enabled: ${selectedItem}`);
    };
    window.disableEquipmentCalibration = () => {
      calibrationState.enabled = false;
      console.log('[EquipmentCalibration] disabled');
    };
    window.selectEquipmentCalibrationItem = (selectedItem: string) => {
      calibrationState.selectedItem = selectedItem;
      console.log(`[EquipmentCalibration] selected: ${selectedItem}`);
    };

    const handleCalibrationKeyDown = (event: KeyboardEvent) => {
      if (!calibrationState.enabled) return;

      const calibrationKeys = new Set([
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'PageUp',
        'PageDown',
        'Digit4',
        'Digit5',
        'Digit6',
        'Digit7',
        'Digit8',
        'Digit9',
        'Comma',
        'Period',
        'KeyO',
      ]);

      if (
        event.code === 'ShiftLeft' ||
        event.code === 'ShiftRight' ||
        event.code === 'AltLeft' ||
        event.code === 'AltRight'
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const selectedItemId = calibrationState.selectedItem;
      const selectedItem = equipmentItemsRef.current.get(selectedItemId);
      if (!selectedItem) {
        if (calibrationKeys.has(event.code)) {
          event.preventDefault();
          event.stopPropagation();
          console.warn(`[EquipmentCalibration] selected item not found: ${selectedItemId}`);
        }
        return;
      }

      const step = event.altKey ? 0.002 : event.shiftKey ? 0.05 : 0.01;
      const rotationStep = event.altKey ? 0.01 : event.shiftKey ? 0.15 : 0.05;
      const scaleStep = event.altKey ? 0.005 : event.shiftKey ? 0.05 : 0.01;
      const parentWorldScale = selectedItem.parent?.getWorldScale(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);
      const positionStep = new THREE.Vector3(
        step / Math.max(Math.abs(parentWorldScale.x), 0.0001),
        step / Math.max(Math.abs(parentWorldScale.y), 0.0001),
        step / Math.max(Math.abs(parentWorldScale.z), 0.0001),
      );
      let moved = false;
      let transformed = false;

      if (event.code === 'ArrowUp') {
        selectedItem.position.z -= positionStep.z;
        moved = true;
      } else if (event.code === 'ArrowDown') {
        selectedItem.position.z += positionStep.z;
        moved = true;
      } else if (event.code === 'ArrowLeft') {
        selectedItem.position.x -= positionStep.x;
        moved = true;
      } else if (event.code === 'ArrowRight') {
        selectedItem.position.x += positionStep.x;
        moved = true;
      } else if (event.code === 'PageUp') {
        selectedItem.position.y += positionStep.y;
        moved = true;
      } else if (event.code === 'PageDown') {
        selectedItem.position.y -= positionStep.y;
        moved = true;
      } else if (event.code === 'Digit4') {
        selectedItem.rotation.x -= rotationStep;
        transformed = true;
      } else if (event.code === 'Digit5') {
        selectedItem.rotation.x += rotationStep;
        transformed = true;
      } else if (event.code === 'Digit6') {
        selectedItem.rotation.y -= rotationStep;
        transformed = true;
      } else if (event.code === 'Digit7') {
        selectedItem.rotation.y += rotationStep;
        transformed = true;
      } else if (event.code === 'Digit8') {
        selectedItem.rotation.z -= rotationStep;
        transformed = true;
      } else if (event.code === 'Digit9') {
        selectedItem.rotation.z += rotationStep;
        transformed = true;
      } else if (event.code === 'Comma') {
        const nextScale = Math.max(0.001, selectedItem.scale.x - scaleStep);
        selectedItem.scale.setScalar(nextScale);
        transformed = true;
      } else if (event.code === 'Period') {
        selectedItem.scale.setScalar(selectedItem.scale.x + scaleStep);
        transformed = true;
      } else if (event.code === 'KeyO') {
        event.preventDefault();
        event.stopPropagation();
        logEquipmentTransform('current transform', selectedItemId, selectedItem);
        return;
      }

      if (!moved && !transformed) return;

      event.preventDefault();
      event.stopPropagation();
      logEquipmentTransform(
        moved ? `moved by ${step}` : `transformed rotation=${rotationStep} scale=${scaleStep}`,
        selectedItemId,
        selectedItem,
      );
    };

    window.addEventListener('keydown', handleCalibrationKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleCalibrationKeyDown, { capture: true });
      delete window.enableEquipmentCalibration;
      delete window.disableEquipmentCalibration;
      delete window.selectEquipmentCalibrationItem;
    };
  }, [enabled, equipmentItemsRef]);
}

function getEquipmentCalibrationState(): EquipmentCalibrationState {
  window.__equipmentCalibrationDebug ??= {
    enabled: false,
    selectedItem: 'sword',
  };
  return window.__equipmentCalibrationDebug;
}

function logEquipmentTransform(label: string, itemId: string, item: THREE.Object3D) {
  console.log(`[EquipmentCalibration] ${label}: ${itemId}`, {
    position: {
      x: Number(item.position.x.toFixed(4)),
      y: Number(item.position.y.toFixed(4)),
      z: Number(item.position.z.toFixed(4)),
    },
    rotation: {
      x: Number(item.rotation.x.toFixed(4)),
      y: Number(item.rotation.y.toFixed(4)),
      z: Number(item.rotation.z.toFixed(4)),
    },
    scale: {
      x: Number(item.scale.x.toFixed(4)),
      y: Number(item.scale.y.toFixed(4)),
      z: Number(item.scale.z.toFixed(4)),
    },
  });
}
