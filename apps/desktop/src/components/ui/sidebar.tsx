import * as React from 'react';
import { PanelLeft } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const SIDEBAR_STORAGE_KEY = 'ccem-sidebar-state';
const DEFAULT_SIDEBAR_WIDTH = 200;
const DEFAULT_SIDEBAR_SHELL_PADDING = 8;
const DEFAULT_WINDOW_CONTROLS_WIDTH = 78;

type SidebarState = 'expanded' | 'collapsed';

interface SidebarContextValue {
  open: boolean;
  state: SidebarState;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  sidebarShellWidth: number;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

interface SidebarProviderProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
  sidebarWidth?: number;
  sidebarShellPadding?: number;
  windowControlsWidth?: number;
}

function readInitialSidebarState(defaultOpen: boolean) {
  if (typeof window === 'undefined') return defaultOpen;
  const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
  if (stored === 'expanded') return true;
  if (stored === 'collapsed') return false;
  return defaultOpen;
}

export function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.');
  }

  return context;
}

const SidebarProvider = React.forwardRef<HTMLDivElement, SidebarProviderProps>(
  ({
    className,
    children,
    defaultOpen = true,
    sidebarWidth = DEFAULT_SIDEBAR_WIDTH,
    sidebarShellPadding = DEFAULT_SIDEBAR_SHELL_PADDING,
    windowControlsWidth = DEFAULT_WINDOW_CONTROLS_WIDTH,
    style,
    ...props
  }, ref) => {
    const [open, setOpen] = React.useState(() => readInitialSidebarState(defaultOpen));

    React.useEffect(() => {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, open ? 'expanded' : 'collapsed');
    }, [open]);

    const toggleSidebar = React.useCallback(() => {
      setOpen((currentOpen) => !currentOpen);
    }, []);

    React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
          return;
        }

        if (event.key.toLowerCase() !== 'b') {
          return;
        }

        const target = event.target as HTMLElement | null;
        const isEditableTarget = !!target && (
          target.isContentEditable
          || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
          || target.getAttribute('role') === 'textbox'
        );

        if (isEditableTarget) {
          return;
        }

        event.preventDefault();
        toggleSidebar();
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [toggleSidebar]);

    const state: SidebarState = open ? 'expanded' : 'collapsed';
    const sidebarShellWidth = open ? sidebarWidth + sidebarShellPadding : 0;

    React.useEffect(() => {
      const root = document.documentElement;
      root.style.setProperty('--ccem-window-controls-width', `${windowControlsWidth}px`);
      root.style.setProperty('--ccem-sidebar-shell-width', `${sidebarShellWidth}px`);

      return () => {
        root.style.removeProperty('--ccem-window-controls-width');
        root.style.removeProperty('--ccem-sidebar-shell-width');
      };
    }, [sidebarShellWidth, windowControlsWidth]);

    const contextValue = React.useMemo<SidebarContextValue>(
      () => ({
        open,
        state,
        setOpen,
        toggleSidebar,
        sidebarShellWidth,
      }),
      [open, state, toggleSidebar, sidebarShellWidth]
    );

    return (
      <SidebarContext.Provider value={contextValue}>
        <div
          ref={ref}
          data-sidebar-state={state}
          className={className}
          style={{
            ...style,
            ['--ccem-sidebar-width' as string]: `${sidebarWidth}px`,
            ['--ccem-sidebar-shell-width' as string]: `${sidebarShellWidth}px`,
            ['--ccem-window-controls-width' as string]: `${windowControlsWidth}px`,
          }}
          {...props}
        >
          {children}
        </div>
      </SidebarContext.Provider>
    );
  }
);
SidebarProvider.displayName = 'SidebarProvider';

const Sidebar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, style, ...props }, ref) => {
    const { state, sidebarShellWidth } = useSidebar();
    const isCollapsed = state === 'collapsed';

    return (
      <div
        ref={ref}
        data-sidebar="sidebar"
        data-state={state}
        className={cn(
          'shrink-0 relative z-20 overflow-hidden transition-[width,padding] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]',
          isCollapsed ? 'p-0' : 'p-2 pr-0',
          className
        )}
        style={{ ...style, width: `${sidebarShellWidth}px` }}
        {...props}
      />
    );
  }
);
Sidebar.displayName = 'Sidebar';

const SidebarInset = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { state } = useSidebar();

    return (
      <div
        ref={ref}
        data-sidebar="inset"
        data-state={state}
        className={cn('min-w-0 flex-1', className)}
        {...props}
      />
    );
  }
);
SidebarInset.displayName = 'SidebarInset';

const SidebarTrigger = React.forwardRef<
  React.ElementRef<typeof Button>,
  React.ComponentPropsWithoutRef<typeof Button>
>(({ className, onClick, ...props }, ref) => {
  const { state, toggleSidebar } = useSidebar();

  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      data-sidebar="trigger"
      className={cn(
        'h-7 w-7 shrink-0 rounded-md border-none bg-transparent p-0 text-muted-foreground/75 shadow-none',
        'hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.96] active:bg-foreground/[0.1]',
        className
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          toggleSidebar();
        }
      }}
      {...props}
    >
      <PanelLeft
        className={cn(
          'h-[15px] w-[15px] transition-transform duration-200',
          state === 'collapsed' && '-scale-x-100'
        )}
      />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
});
SidebarTrigger.displayName = 'SidebarTrigger';

export { Sidebar, SidebarInset, SidebarProvider, SidebarTrigger };
