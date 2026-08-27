import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MAX_WORKSPACE_ANNOTATIONS,
  MAX_WORKSPACE_ANNOTATION_NOTE_CHARS,
  MAX_WORKSPACE_ANNOTATION_TOTAL_CHARS,
  normalizeStoredWorkspaceAnnotations,
  normalizeWorkspaceSelection,
  type WorkspaceAnnotation,
  type WorkspaceAnnotationAnchor,
} from './workspaceAnnotationModel';

const STORAGE_PREFIX = 'ccem:workspace-annotations:v1:';

interface AnnotationState {
  sessionKey: string | null;
  items: WorkspaceAnnotation[];
}

function storageKey(sessionKey: string): string {
  return `${STORAGE_PREFIX}${sessionKey}`;
}

function readAnnotations(sessionKey: string | null): WorkspaceAnnotation[] {
  if (!sessionKey || typeof sessionStorage === 'undefined') {
    return [];
  }

  try {
    const stored = sessionStorage.getItem(storageKey(sessionKey));
    return stored ? normalizeStoredWorkspaceAnnotations(JSON.parse(stored)) : [];
  } catch {
    return [];
  }
}

function writeAnnotations(sessionKey: string, items: WorkspaceAnnotation[]) {
  try {
    if (items.length === 0) {
      sessionStorage.removeItem(storageKey(sessionKey));
      return;
    }
    sessionStorage.setItem(storageKey(sessionKey), JSON.stringify(items));
  } catch (error) {
    console.warn('Failed to persist workspace annotations:', error);
  }
}

function createAnnotationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function useWorkspaceAnnotations(sessionKey: string | null) {
  const [state, setState] = useState<AnnotationState>(() => ({
    sessionKey,
    items: readAnnotations(sessionKey),
  }));

  useEffect(() => {
    setState({
      sessionKey,
      items: readAnnotations(sessionKey),
    });
  }, [sessionKey]);

  const annotations = state.sessionKey === sessionKey ? state.items : [];
  // Annotations not yet sent with a prompt — these are what the composer
  // attaches; sent ones stay on the transcript as markers only.
  const pendingAnnotations = useMemo(
    () => annotations.filter((annotation) => !annotation.sentAt),
    [annotations],
  );
  const annotationCharCount = useMemo(
    () => annotations.reduce(
      (total, annotation) => total + annotation.quote.length + annotation.note.length,
      0,
    ),
    [annotations],
  );

  const updateItems = useCallback((
    updater: (items: WorkspaceAnnotation[]) => WorkspaceAnnotation[],
  ) => {
    if (!sessionKey) {
      return;
    }
    setState((previous) => {
      const current = previous.sessionKey === sessionKey
        ? previous.items
        : readAnnotations(sessionKey);
      const items = normalizeStoredWorkspaceAnnotations(updater(current));
      writeAnnotations(sessionKey, items);
      return { sessionKey, items };
    });
  }, [sessionKey]);

  const addAnnotation = useCallback((
    quote: string,
    note: string,
    anchor?: WorkspaceAnnotationAnchor,
  ): boolean => {
    const normalizedQuote = normalizeWorkspaceSelection(quote);
    const normalizedNote = note.trim();
    if (
      !normalizedQuote
      || !normalizedNote
      || normalizedNote.length > MAX_WORKSPACE_ANNOTATION_NOTE_CHARS
      || annotations.length >= MAX_WORKSPACE_ANNOTATIONS
      || annotationCharCount + normalizedQuote.length + normalizedNote.length > MAX_WORKSPACE_ANNOTATION_TOTAL_CHARS
    ) {
      return false;
    }

    updateItems((items) => [...items, {
      id: createAnnotationId(),
      quote: normalizedQuote,
      note: normalizedNote,
      createdAt: new Date().toISOString(),
      ...(anchor ? { anchor } : {}),
    }]);
    return true;
  }, [annotationCharCount, annotations.length, updateItems]);

  const updateAnnotation = useCallback((id: string, note: string): boolean => {
    const normalizedNote = note.trim();
    if (!normalizedNote || normalizedNote.length > MAX_WORKSPACE_ANNOTATION_NOTE_CHARS) {
      return false;
    }
    const nextCharCount = annotationCharCount + normalizedNote.length
      - (annotations.find((item) => item.id === id)?.note.length ?? 0);
    if (nextCharCount > MAX_WORKSPACE_ANNOTATION_TOTAL_CHARS) {
      return false;
    }
    updateItems((items) => items.map((item) => (
      item.id === id ? { ...item, note: normalizedNote } : item
    )));
    return true;
  }, [annotationCharCount, annotations, updateItems]);

  const removeAnnotation = useCallback((id: string) => {
    updateItems((items) => items.filter((item) => item.id !== id));
  }, [updateItems]);

  const clearAnnotations = useCallback(() => {
    updateItems(() => []);
  }, [updateItems]);

  // Sending a prompt stamps sentAt instead of wiping the list: the highlight
  // and numbered marker stay at the original text, but the annotation is not
  // re-attached to later prompts.
  const markAllSent = useCallback(() => {
    updateItems((items) => items.map((item) => (
      item.sentAt ? item : { ...item, sentAt: new Date().toISOString() }
    )));
  }, [updateItems]);

  const clearPendingAnnotations = useCallback(() => {
    updateItems((items) => items.filter((item) => item.sentAt));
  }, [updateItems]);

  return useMemo(() => ({
    annotations,
    pendingAnnotations,
    canAddAnnotation: annotations.length < MAX_WORKSPACE_ANNOTATIONS
      && annotationCharCount < MAX_WORKSPACE_ANNOTATION_TOTAL_CHARS,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations,
    markAllSent,
    clearPendingAnnotations,
  }), [
    addAnnotation,
    annotations,
    annotationCharCount,
    clearAnnotations,
    clearPendingAnnotations,
    markAllSent,
    pendingAnnotations,
    removeAnnotation,
    updateAnnotation,
  ]);
}
