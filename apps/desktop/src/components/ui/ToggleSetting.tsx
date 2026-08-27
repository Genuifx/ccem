import { Switch } from '@/components/ui/switch';

/**
 * Settings toggle row (label + description + shadcn Switch). The title is bound
 * to the Switch as its accessible name (aria-label), satisfying the project's
 * shadcn + a11y rules (no hand-rolled role=switch without a name).
 */
export function ToggleSetting({ checked, onChange, title, description }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">
          {title}
        </div>
        <div className="text-sm text-muted-foreground">
          {description}
        </div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={title}
        title={title}
      />
    </div>
  );
}
