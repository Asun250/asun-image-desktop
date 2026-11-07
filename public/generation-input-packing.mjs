// The provider accepts sixteen files. Overflow is represented by labeled boards;
// logical inputs and their roles remain separate from physical API image indexes.
export const GENERATION_PROVIDER_IMAGE_LIMIT = 16;
export const GENERATION_BOARD_MAX_SIDE = 4096;
export const GENERATION_BOARD_MIN_CELL = 512;
export const GENERATION_BOARD_MAX_TILES = 64;
const protectedRoles = new Set(['current composition', 'drawn scene composition', 'canvas annotation guide', 'area selection mask',
  'original Blender blockout — structure authority', 'primary subject original']);
const need = (condition, message) => {if (!condition) throw new Error(message);};
const dimensions = image => Number.isSafeInteger(image?.width) && image.width > 0 && Number.isSafeInteger(image?.height) && image.height > 0;
const single = sourceIndex => ({kind:'single', sourceIndex});

function board(indices, images) {
  const columns = Math.ceil(Math.sqrt(indices.length)), rows = Math.ceil(indices.length / columns);
  const padding = 16, header = 56;
  const naturalCell = Math.max(GENERATION_BOARD_MIN_CELL, ...indices.map(index => {
    const image = images[index - 1];return Math.max(image.width + padding * 2, image.height + header + padding);
  }));
  const cell = Math.min(naturalCell, 2048, Math.floor(GENERATION_BOARD_MAX_SIDE / Math.max(columns, rows)));
  need(indices.length <= GENERATION_BOARD_MAX_TILES && cell >= GENERATION_BOARD_MIN_CELL,
    'These references cannot fit into readable image boards. Use a smaller set for this generation; no references were removed.');
  const innerWidth = cell - padding * 2, innerHeight = cell - header - padding;
  return {kind:'board', width:columns * cell, height:rows * cell, tiles:indices.map((sourceIndex, index) => {
    const image = images[sourceIndex - 1], x = (index % columns) * cell, y = Math.floor(index / columns) * cell;
    const scale = Math.min(1, innerWidth / image.width, innerHeight / image.height);
    const width = Math.max(1, Math.floor(image.width * scale)), height = Math.max(1, Math.floor(image.height * scale));
    return {sourceIndex, label:`Input ${sourceIndex}`, x, y, width:cell, height:cell,
      imageRect:{x:x + padding + Math.floor((innerWidth - width) / 2), y:y + header + Math.floor((innerHeight - height) / 2), width, height}};
  })};
}

/** Pure, deterministic placement plan shared by the browser and backend. */
export function planGenerationInputPacking(images, roles = []) {
  need(Array.isArray(images) && images.every(dimensions), 'Every generation input needs its actual image dimensions.');
  need(Array.isArray(roles) && roles.every(role => role && Number.isSafeInteger(role.image) && role.image >= 1 && role.image <= images.length && typeof role.role === 'string'),
    'The image roles do not match the generation inputs. Rebuild the request.');
  if (images.length <= GENERATION_PROVIDER_IMAGE_LIMIT) return {version:1, packed:false,
    logicalInputCount:images.length, physicalInputCount:images.length, slots:images.map((_, index) => single(index + 1))};
  const protectedImages = new Set(roles.filter(role => protectedRoles.has(role.role)).map(role => role.image));
  const fixed = [], remaining = [];
  for (let index = 1; index <= images.length; index++) (protectedImages.has(index) ? fixed : remaining).push(index);
  const available = GENERATION_PROVIDER_IMAGE_LIMIT - fixed.length;
  need(available > 0, 'Too many composition or blockout inputs need their own image files. Keep fewer standalone sources before generating; none were removed.');
  need(remaining.length <= available * GENERATION_BOARD_MAX_TILES,
    'These references cannot fit into readable image boards. Use a smaller set for this generation; no references were removed.');
  // Balance the groups while retaining singleton inputs byte-for-byte. This uses
  // the available image slots instead of needlessly shrinking every reference.
  const groupCount = Math.min(remaining.length, available), base = Math.floor(remaining.length / groupCount), extra = remaining.length % groupCount;
  const slots = fixed.map(single);let offset = 0;
  for (let index = 0; index < groupCount; index++) {
    const size = base + (index < extra ? 1 : 0), indices = remaining.slice(offset, offset + size);offset += size;
    slots.push(size === 1 ? single(indices[0]) : board(indices, images));
  }
  return {version:1, packed:true, logicalInputCount:images.length, physicalInputCount:slots.length, slots};
}

function validateRenderPlan(images, plan) {
  need(Array.isArray(images) && images.every(dimensions) && plan?.version === 1 && plan.logicalInputCount === images.length &&
    Array.isArray(plan.slots) && plan.slots.length === plan.physicalInputCount && plan.slots.length <= GENERATION_PROVIDER_IMAGE_LIMIT,
    'The reference board plan no longer matches the generation inputs. Rebuild the request.');
  const used = new Set();
  const use = index => {
    need(Number.isSafeInteger(index) && index >= 1 && index <= images.length && !used.has(index), 'The reference board plan contains a missing or repeated input. Rebuild the request.');
    used.add(index);
  };
  for (const slot of plan.slots) {
    if (slot.kind === 'single') {use(slot.sourceIndex);continue;}
    need(slot.kind === 'board' && dimensions(slot) && slot.width <= GENERATION_BOARD_MAX_SIDE && slot.height <= GENERATION_BOARD_MAX_SIDE &&
      Array.isArray(slot.tiles) && slot.tiles.length >= 2 && slot.tiles.length <= GENERATION_BOARD_MAX_TILES,
      'The reference board dimensions are invalid. Rebuild the request.');
    for (const tile of slot.tiles) {
      use(tile.sourceIndex);
      const rect = tile.imageRect;
      need(dimensions(tile) && tile.width >= GENERATION_BOARD_MIN_CELL && tile.height >= GENERATION_BOARD_MIN_CELL &&
        Number.isSafeInteger(tile.x) && Number.isSafeInteger(tile.y) && tile.x >= 0 && tile.y >= 0 && tile.x + tile.width <= slot.width && tile.y + tile.height <= slot.height &&
        dimensions(rect) && Number.isSafeInteger(rect.x) && Number.isSafeInteger(rect.y) && rect.x >= tile.x && rect.y >= tile.y + 56 &&
        rect.x + rect.width <= tile.x + tile.width && rect.y + rect.height <= tile.y + tile.height && tile.label === `Input ${tile.sourceIndex}`,
        'A reference board tile is invalid. Rebuild the request.');
    }
  }
  need(used.size === images.length, 'The reference board plan leaves out an input. Rebuild the request.');
}

/** Only board files are rendered; standalone originals keep their source bytes. */
export async function renderGenerationInputBoards(images, plan) {
  validateRenderPlan(images, plan);
  const result = [];
  for (const [index, slot] of plan.slots.entries()) {
    if (slot.kind !== 'board') continue;
    const canvas = document.createElement('canvas');canvas.width = slot.width;canvas.height = slot.height;
    try {
      const context = canvas.getContext('2d');need(context, 'This browser could not create a reference board.');
      context.fillStyle = '#ffffff';context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;context.imageSmoothingQuality = 'high';
      for (const tile of slot.tiles) {
        const image = images[tile.sourceIndex - 1];
        need(typeof image.source === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(image.source), `Input ${tile.sourceIndex} has no readable original image. No references were omitted.`);
        const decoded = new Image();
        try {
          decoded.src = image.source;await decoded.decode();
          need(decoded.naturalWidth === image.width && decoded.naturalHeight === image.height, `Input ${tile.sourceIndex} does not match its recorded dimensions. Rebuild the request.`);
          const rect = tile.imageRect;
          context.drawImage(decoded, rect.x, rect.y, rect.width, rect.height);
        } catch (error) {
          throw new Error(`Could not prepare Input ${tile.sourceIndex}: ${error.message || 'the image could not be decoded'}. No references were omitted.`);
        } finally {decoded.removeAttribute('src');}
        context.strokeStyle = '#d5d9de';context.lineWidth = 2;
        context.strokeRect(tile.x + 1, tile.y + 1, tile.width - 2, tile.height - 2);
        context.fillStyle = '#17202a';context.font = 'bold 32px Arial, sans-serif';context.textAlign = 'left';context.textBaseline = 'middle';
        context.fillText(tile.label, tile.x + 16, tile.y + 28, tile.width - 32);
      }
      const source = canvas.toDataURL('image/png');need(source.startsWith('data:image/png;base64,'), 'The reference board could not be encoded. No references were omitted.');
      result.push({slot:index + 1, image:{name:`Reference board ${index + 1}.png`, source, width:slot.width, height:slot.height}});
      // Give input and paint events a turn between potentially large boards.
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {canvas.width = canvas.height = 1;}
  }
  return result;
}
