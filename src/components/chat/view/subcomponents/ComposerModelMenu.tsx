import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { ProviderModelOption } from '../../../../types/app';
import { modelVersionKey, uniqueModelVersions, selectModelVersion } from '../../utils/modelIdentity';
import { DEFAULT_EFFORT_VALUE } from '../../constants/providerEffort';
import { useComposerMenuAnchor } from '../../hooks/useComposerMenuAnchor';

import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from './ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

interface ComposerModelMenuProps {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
  onRefreshModels?: () => void;
}

export default function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
  onRefreshModels,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isModelSectionOpen, setIsModelSectionOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  // The model list starts collapsed every time the menu opens, the way Codex
  // shows reasoning first and keeps the longer model list one click away.
  useEffect(() => {
    if (!isOpen) {
      setIsModelSectionOpen(false);
    }
  }, [isOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effort === DEFAULT_EFFORT_VALUE
    ? defaultEffortLabel
    : effort === 'ultracode' ? 'Ultracode' : effort;

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );
  const modelLabel = selectedModelOption?.value === 'default' && selectedModelOption.selectionKind === 'alias'
    ? t('modelIdentity.followRemote', { defaultValue: 'Follow remote configuration' })
    : selectedModelOption?.label || model;
  const hasModelMetadata = modelOptions.some((option) => option.selectionKind);
  const versionOptions = hasModelMetadata ? uniqueModelVersions(modelOptions) : modelOptions;
  const contextOptions = selectedModelOption && hasModelMetadata
    ? modelOptions.filter((option) => modelVersionKey(option) === modelVersionKey(selectedModelOption))
    : [];

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading;
  if (!hasEffortSection && !hasModelSection) {
    return null;
  }

  const triggerLabel = hasModelSection ? modelLabel : effortLabel;
  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          if (!isOpen) onRefreshModels?.();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-20 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-56"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{triggerLabel}</span>
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && (
          <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">· {effortLabel}</span>
        )}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {hasEffortSection && (
            <>
              <ComposerMenuHeading>
                {t('modelIdentity.reasoning', { defaultValue: 'Reasoning effort' })}
              </ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value === 'ultracode' ? 'Ultracode' : option.value}
                  description={option.value === 'ultracode'
                    ? t('composer.ultracodeDescription', { defaultValue: 'xhigh reasoning with automatic workflows. Uses more API tokens.' })
                    : option.description}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                  className="capitalize"
                />
              ))}
            </>
          )}

          {contextOptions.length > 0 && (
            <>
              {hasEffortSection && <ComposerMenuSeparator />}
              <ComposerMenuHeading>{t('modelIdentity.context', { defaultValue: 'Context capacity' })}</ComposerMenuHeading>
              {contextOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.contextMode === '1m' ? '1M tokens' : t('modelIdentity.remoteDefault', { defaultValue: 'Remote default' })}
                  description={option.maxInputTokens ? t('modelIdentity.maximumInput', { defaultValue: 'Catalog maximum input: {{tokens}} tokens', tokens: option.maxInputTokens.toLocaleString() }) : undefined}
                  isSelected={option.value === model}
                  onSelect={() => { onSelectModel(option.value); setIsOpen(false); }}
                />
              ))}
              <p className="px-2.5 py-1 text-xs text-muted-foreground">{t('modelIdentity.contextHint', { defaultValue: '1M is context capacity, not a model version.' })}</p>
            </>
          )}
          {hasModelSection && (
            <>
              {hasEffortSection && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={modelLabel}
                isSelected={false}
                onSelect={() => setIsModelSectionOpen((current) => !current)}
                trailing={
                  isModelSectionOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
                className="text-muted-foreground"
              />

              {isModelSectionOpen && (
                <>
                  <ComposerMenuHeading>
                    {t('modelIdentity.version', { defaultValue: 'Model version' })}
                  </ComposerMenuHeading>
                  {modelOptions.length === 0 && modelsLoading && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                    </p>
                  )}
                  {versionOptions.map((option) => (
                    <ComposerMenuItem
                      key={option.value}
                      label={option.value === 'default' && option.selectionKind === 'alias' ? t('modelIdentity.followRemote', { defaultValue: 'Follow remote configuration' }) : option.label || option.value}
                      description={hasModelMetadata ? [
                        option.selectionKind === 'alias' ? t('modelIdentity.alias', { defaultValue: 'Alias · follows remote configuration' })
                          : option.catalogSource === 'remote-config' ? t('modelIdentity.configured', { defaultValue: 'Remote configuration · availability unconfirmed' })
                          : option.catalogSource === 'manual' ? t('modelIdentity.manual', { defaultValue: 'Manual ID · availability unconfirmed' })
                          : t('modelIdentity.remoteCatalog', { defaultValue: 'Reported by this remote' }),
                        option.resolvedModel ? `${t('modelIdentity.resolvesTo', { defaultValue: 'Resolves to' })}: ${option.resolvedModel}` : '',
                      ].filter(Boolean).join(' · ') : option.description}
                      isSelected={hasModelMetadata ? modelVersionKey(option) === model.replace(/\[1m\]$/i, '') : option.value === model}
                      onSelect={() => {
                        onSelectModel(hasModelMetadata ? selectModelVersion(modelOptions, option, selectedModelOption) : option.value);
                        setIsOpen(false);
                      }}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}
