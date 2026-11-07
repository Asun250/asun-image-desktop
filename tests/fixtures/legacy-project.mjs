// Hand-authored version-3 fixture matching the pre-rebrand project schema.
// Keep this independent of current core builders so compatibility regressions
// cannot silently update the expected old document. Image pixels are synthetic.
export function legacyProjectFixture(main, reference) {
  const appearance = {visible: true, opacity: 1, brightness: 100, contrast: 100, saturation: 100};
  const assetId = 'legacy-main-asset', rasterId = 'legacy-raster', referenceId = 'legacy-reference';
  const image = ({name, source, width, height, originalFile}) => ({name, source, width, height, originalFile: structuredClone(originalFile)});
  return {
    format: 'asun-image', version: 3, name: 'Asun image archive (user title)', width: 320, height: 240,
    assets: {[assetId]: {id: assetId, ...image(main)}},
    layers: [
      {id: rasterId, kind: 'raster', name: main.name, x: 0, y: 0, width: 320, height: 240, ...appearance,
        assetId, mask: [{mode: 'hide', size: 30, points: [[160, 120]]}]},
      {id: 'legacy-number', kind: 'text', name: '1', x: 20, y: 20, width: 20, height: 28, ...appearance,
        mask: [], text: {content: '1', fontSize: 24, color: '#ffffff', fontFamily: 'Arial', baseWidth: 20, baseHeight: 28}, referenceIds: [referenceId]},
    ],
    references: [{id: referenceId, ...image(reference), annotations: [], notes: 'Asun image is user-authored text and stays unchanged.'}],
    prompt: 'Keep the user project and original image files.', variants: [], original: {assetId, width: 320, height: 240},
  };
}
