//@ts-check
/** Site operator/execution services for the shared project editor host. */
import { createProjectHost } from '@jarenjs/studio/component';
import { loadStudioDocument } from './studio.js';
import { operatorRegistry, runQuery, runJslt } from './engines.js';
import { runValidation } from './validator.js';
export const projectHost = createProjectHost({ operators: operatorRegistry, loadDocument: loadStudioDocument, runQuery, runJslt, runValidation });
export const { projectComponent, projectSnapshot, projectAppFile, commitProject, runProjectFile, createProjectStageWidget, createProjectSplitterWidget } = projectHost;
