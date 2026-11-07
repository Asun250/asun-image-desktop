// Reset only the current in-memory project. Existing files and history
// snapshots remain independent so one Undo can restore the entire project.
import {newProject,validateProject} from './core.mjs';

const empty=newProject();

/** Include retained sources and settings even when the Layers list is empty. */
export function hasProjectContent(project){
  return Boolean(project&&(project.format!==empty.format||project.version!==empty.version||project.name!==empty.name||project.width!==empty.width||project.height!==empty.height||project.prompt!==''||project.original!==null||Object.keys(project.assets||{}).length||(project.layers||[]).length||(project.references||[]).length||(project.variants||[]).length));
}

/** Return a fresh schema-3 project; an untouched default project is a no-op. */
export function resetProject(project){
  validateProject(project);
  return hasProjectContent(project)?newProject():project;
}
