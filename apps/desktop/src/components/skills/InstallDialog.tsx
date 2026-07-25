import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLocale } from '@/locales';
import { toast } from 'sonner';
import { Download, Loader2 } from '@/lib/lucide-react';
import { ccemMotion, clearMotionProps, getMotionTargets, gsap, shouldReduceMotion, useGSAP } from '@/lib/gsapMotion';

interface InstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packageId: string;
  skillName: string;
  displayName: string;
  installType: string; // "skills" | "plugin"
}

export function InstallDialog({
  open,
  onOpenChange,
  packageId,
  skillName,
  displayName,
  installType,
}: InstallDialogProps) {
  const { t } = useLocale();
  const [agents, setAgents] = useState<string[]>(['Claude Code']);
  const [installing, setInstalling] = useState(false);
  const installDialogMotionRef = useRef<HTMLDivElement>(null);

  const toggleAgent = (agent: string) => {
    setAgents((prev) =>
      prev.includes(agent)
        ? prev.filter((a) => a !== agent)
        : [...prev, agent]
    );
  };

  const handleInstall = async () => {
    setInstalling(true);
    toast.info(t('skills.installStarted').replace('{name}', displayName), { duration: 4000 });

    try {
      await invoke('install_skill', {
        packageId,
        skillName: installType === 'skills' ? skillName : null,
        global: true,
        agents: agents.length > 0 ? agents : null,
      });
    } catch {
      // error will come via event
    }

    setInstalling(false);
    onOpenChange(false);
  };

  useGSAP(() => {
    if (!open) {
      return;
    }

    const root = installDialogMotionRef.current;
    if (!root) {
      return;
    }

    const targets = getMotionTargets(root, '[data-skill-install-motion]', 6);
    if (shouldReduceMotion()) {
      clearMotionProps(targets);
      return;
    }

    if (targets.length > 0) {
      gsap.killTweensOf(targets);
      gsap.fromTo(
        targets,
        { autoAlpha: 0, y: 6 },
        {
          autoAlpha: 1,
          y: 0,
          duration: ccemMotion.duration.quick,
          ease: ccemMotion.ease.standard,
          stagger: 0.03,
          overwrite: 'auto',
          onComplete: () => clearMotionProps(targets),
        },
      );
    }

    if (installing) {
      const action = root.querySelector<HTMLElement>('[data-skill-install-action]');
      if (action) {
        gsap.fromTo(
          action,
          { scale: 0.96 },
          {
            scale: 1,
            duration: ccemMotion.duration.quick,
            ease: ccemMotion.ease.standard,
            overwrite: 'auto',
            onComplete: () => clearMotionProps(action),
          },
        );
      }
    }
  }, { scope: installDialogMotionRef, dependencies: [open, installing] });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={installDialogMotionRef} className="frosted-panel glass-noise sm:max-w-md">
        <DialogHeader data-skill-install-motion>
          <DialogTitle>{t('skills.installDialogTitle')}</DialogTitle>
          <DialogDescription>{displayName}</DialogDescription>
        </DialogHeader>

        <div data-skill-install-motion className="space-y-4 py-2">
          {/* Agent selection */}
          <div>
            <p className="text-sm font-medium text-foreground mb-3">
              {t('skills.selectAgents')}
            </p>
            <div className="flex flex-col gap-2">
              {[
                { id: 'Claude Code', label: t('skills.agentClaudeCode') },
                { id: 'Codex', label: t('skills.agentCodex') },
              ].map(({ id, label }) => (
                <label
                  key={id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[hsl(var(--glass-border-light)/0.15)] bg-surface-raised/50 cursor-pointer hover:bg-surface-raised transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={agents.includes(id)}
                    onChange={() => toggleAgent(id)}
                    className="w-4 h-4 rounded border-border accent-primary"
                  />
                  <span className="text-sm text-foreground">{label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter data-skill-install-motion>
          <Button
            variant="outline"
            className="glass-btn-outline"
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            data-skill-install-action
            onClick={handleInstall}
            disabled={installing || agents.length === 0}
          >
            {installing ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <Download className="w-4 h-4 mr-1.5" />
            )}
            {installing ? t('skills.installing') : t('skills.confirmInstall')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
