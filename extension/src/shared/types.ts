export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageElement {
  id: string;
  role: string;
  name: string;
  input_type?: string | null;
  autocomplete?: string | null;
  value?: string | null;
  checked?: boolean | null;
  selected_options?: string[] | null;
  visible: boolean;
  enabled: boolean;
  bbox?: BoundingBox | null;
}

export interface PageIR {
  url: string;
  title: string;
  elements: PageElement[];
  text_snippets: string[];
  observed_at: string;
}
export type ClickAction = { action: 'click'; element_id: string };
export type TypeAction = { action: 'type'; element_id: string; text: string };
export type SelectAction = { action: 'select'; element_id: string; option: string };
export type ScrollAction = { action: 'scroll'; direction: 'up' | 'down'; amount: number };
export type NavigateAction = { action: 'navigate'; url: string };
export type WaitAction = { action: 'wait'; duration_ms: number };
export type ExtractAction = { action: 'extract'; element_id: string };
export type DoneAction = { action: 'done'; summary: string };

export type AgentAction =
  | ClickAction
  | TypeAction
  | SelectAction
  | ScrollAction
  | NavigateAction
  | WaitAction
  | ExtractAction
  | DoneAction;

export interface ExecutionResult {
  success: boolean;
  error?: string;
  extracted_data?: string;
}