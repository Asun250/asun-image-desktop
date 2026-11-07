// Shared, DOM-free description of an editable sketch scene.
export function isSketchProject(project) {
  return project?.sketch?.version === 1;
}
export function sketchSurfaceLayer(project) {
  return isSketchProject(project) ? project.layers?.find(layer => layer.id === project.sketch.surfaceLayerId && layer.kind === 'raster') || null : null;
}
export function sketchContentLayers(project) {
  return (project?.layers || []).filter(layer => {
    if (!layer.visible || layer.opacity <= 0) return false;
    if (layer.kind === 'drawing') return layer.drawing?.mode === 'pencil';
    if (layer.kind === 'text') return !layer.objectRegion && !layer.referenceComment?.trim() && !layer.referenceIds?.length && !layer.referenceId && !/^\s*\d+\s*$/.test(layer.text?.content || '');
    return layer.kind === 'raster';
  });
}
export function validateSketchMetadata(project) {
  if (!Object.hasOwn(project, 'sketch')) return;
  const sketch = project.sketch;
  if (!sketch || sketch.version !== 1 || sketch.background !== '#ffffff' || typeof sketch.surfaceLayerId !== 'string' || !sketchSurfaceLayer(project)) throw new Error('This sketch is missing its editable drawing surface.');
  if ((sketchSurfaceLayer(project).rotation ?? 0) !== 0) throw new Error('Keep the sketch drawing page upright. Rotate the canvas view instead.');
}
