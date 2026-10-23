// The three MCP Apps views (apps/views build), imported as wrangler Text modules: each is one self contained
// HTML file served from resources/read with the MCP Apps MIME type.

import stepper from '../../../views/dist/stepper.html';
import carousel from '../../../views/dist/carousel.html';
import repairCard from '../../../views/dist/repair-card.html';
import { VIEW_URIS } from '@fixwright/protocol';

export interface ViewResource {
  name: string;
  uri: string;
  description: string;
  html: string;
}

export const VIEWS: readonly ViewResource[] = [
  { name: 'Fixwright diagnosis stepper', uri: VIEW_URIS.stepper, description: 'Diagnosis and repair stepper: probes, causes, the question, the dry run and its steps.', html: stepper },
  { name: 'Fixwright checkup carousel', uri: VIEW_URIS.carousel, description: 'Checkup findings as three to five cards, one action each.', html: carousel },
  { name: 'Fixwright repair card', uri: VIEW_URIS.repair_card, description: 'A repair with its read back, undo, and the next morning check.', html: repairCard },
];
