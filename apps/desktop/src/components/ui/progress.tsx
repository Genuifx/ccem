import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '@/lib/utils';

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value = null, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    value={value}
    className={cn('relative h-1 w-full overflow-hidden rounded-full bg-primary/10', className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn('h-full rounded-full bg-primary/70', value === null ? 'progress-indeterminate w-1/3' : 'w-full transition-transform')}
      style={value === null ? undefined : { transform: `translateX(-${100 - value}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
