import { describe, expect, it } from 'vitest';
import { publicAssetPath } from './publicAssets';

describe('publicAssetPath', () => {
  it('keeps root builds rooted at slash', () => {
    expect(publicAssetPath('models/wizard2/wizard2.fbx', '/')).toBe('/models/wizard2/wizard2.fbx');
  });

  it('prefixes beta builds with the beta base path', () => {
    expect(publicAssetPath('models/wizard2/wizard2.fbx', '/beta/')).toBe('/beta/models/wizard2/wizard2.fbx');
  });

  it('normalizes base URLs and asset paths', () => {
    expect(publicAssetPath('/skybox/corona_ft.png', '/beta')).toBe('/beta/skybox/corona_ft.png');
  });
});
