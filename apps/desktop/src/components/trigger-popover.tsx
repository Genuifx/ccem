'use client'

import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import type { TriggerSuggestion } from './types'

type TriggerPopoverProps = {
  suggestions: TriggerSuggestion[]
  loading: boolean
  error?: string | null
  emptyMessage?: string
  selectedIndex: number
  onSelect: (suggestion: TriggerSuggestion) => void
  onDismiss: () => void
  triggerRect?: DOMRect | null
  triggerChar: string
  placement?: 'anchored' | 'static'
  className?: string
}

function getSuggestionKind(suggestion: TriggerSuggestion): string | null {
  const data = suggestion.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null
  }

  const kind = (data as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

function getSuggestionPath(suggestion: TriggerSuggestion): string | null {
  const data = suggestion.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null
  }

  const path = (data as { path?: unknown }).path
  return typeof path === 'string' && path.trim().length > 0 ? path : null
}

/**
 * Floating popover that displays trigger suggestions.
 * Positioned relative to the trigger character location in the editor.
 */
export function TriggerPopover({
  suggestions,
  loading,
  error,
  emptyMessage,
  selectedIndex,
  onSelect,
  onDismiss,
  triggerRect,
  triggerChar,
  placement = 'anchored',
  className,
}: TriggerPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)

  // Scroll selected item into view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Click outside to dismiss
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target
      if (popoverRef.current && target instanceof Node && !popoverRef.current.contains(target)) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onDismiss])

  if (placement === 'anchored' && !triggerRect) return null
  if (suggestions.length === 0 && !loading && !error && !emptyMessage) return null

  const style: CSSProperties | undefined = (() => {
    if (placement === 'static' || !triggerRect) return undefined
    // Position the popover below the trigger character, clamped to viewport
    const popoverMaxWidth = Math.min(320, window.innerWidth - 16)
    const left = Math.min(triggerRect.left, window.innerWidth - popoverMaxWidth - 8)
    return {
      position: 'fixed',
      left: `${Math.max(8, left)}px`,
      top: `${triggerRect.bottom + 4}px`,
      zIndex: 50,
      maxWidth: `${popoverMaxWidth}px`,
    }
  })()

  return (
    <div
      ref={popoverRef}
      className={cn(
        'max-h-[240px] min-w-[200px] overflow-y-auto',
        placement === 'anchored'
          ? 'bg-popover rounded-xl border p-2 shadow-md animate-in fade-in-0 zoom-in-95'
          : 'w-full min-w-0 bg-transparent p-0 shadow-none',
        className,
      )}
      style={style}
      role="listbox"
      aria-label={`${triggerChar} suggestions`}>
      {loading ? (
        <div
          role="option"
          aria-selected={false}
          className="text-muted-foreground px-3 py-2 text-sm">
          Loading suggestions...
        </div>
      ) : error ? (
        <div role="option" aria-selected={false} className="text-destructive px-3 py-2 text-sm">
          {error}
        </div>
      ) : suggestions.length === 0 && emptyMessage ? (
        <div
          role="option"
          aria-selected={false}
          className="text-muted-foreground px-3 py-2 text-sm">
          {emptyMessage}
        </div>
      ) : (
        suggestions.map((suggestion, index) => {
          const kind = getSuggestionKind(suggestion)
          const path = kind === 'skill' ? getSuggestionPath(suggestion) : null

          return (
            <button
              key={suggestion.value}
              ref={index === selectedIndex ? selectedRef : undefined}
              type="button"
              disabled={suggestion.disabled}
              role="option"
              aria-selected={index === selectedIndex}
              className={cn(
                'flex w-full items-start gap-1.5 rounded-lg px-1.5 py-1 text-left transition-colors',
                index === selectedIndex
                  ? 'bg-primary/[0.08] ring-1 ring-inset ring-primary/30'
                  : 'hover:bg-primary/[0.045]',
                suggestion.disabled && 'cursor-not-allowed opacity-55',
              )}
              onMouseDown={(e) => {
                e.preventDefault() // Prevent blur on the editor
                if (suggestion.disabled) return
                onSelect(suggestion)
              }}>
              {suggestion.icon && (
                <span className={cn(
                  'mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]',
                  kind === 'skill'
                    ? 'bg-primary/[0.055] text-primary'
                    : 'bg-muted/35 text-muted-foreground',
                )}>
                  <span className="block scale-[0.9]">{suggestion.icon}</span>
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate text-[11px] font-medium leading-4 text-foreground">{suggestion.label}</span>
                  {path ? (
                    <span className="ml-auto min-w-0 max-w-[55%] truncate font-mono text-[8px] leading-4 text-muted-foreground/65" title={path}>
                      {path}
                    </span>
                  ) : null}
                </div>
                {suggestion.description && (
                  <div className="mt-0.5 truncate text-[9px] leading-3.5 text-muted-foreground opacity-80">
                    {suggestion.description}
                  </div>
                )}
                {suggestion.badges?.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {suggestion.badges.map((badge) => (
                      <span
                        key={badge}
                        className="rounded-[5px] bg-muted/60 px-1 py-0.5 text-[8px] leading-3 text-muted-foreground">
                        {badge}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </button>
          )
        })
      )}
    </div>
  )
}
