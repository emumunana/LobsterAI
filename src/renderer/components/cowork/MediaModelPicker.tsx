import Lottie from 'lottie-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { CheckIcon } from '@heroicons/react/24/outline';

import mediaGenAnimation from '../icons/MediaGenIcon.json';
import MagicIcon from '../icons/MagicIcon';
import { getProviderIcon } from '../../providers/uiRegistry';
import { authService } from '../../services/auth';
import { i18nService } from '../../services/i18n';
import { localStore } from '../../services/store';
import { RootState } from '../../store';
import { setMediaModels, setMediaSelection } from '../../store/slices/coworkSlice';
import type { MediaGenerationMode, MediaModel } from '../../types/mediaGeneration';

interface SavedMediaSelection {
  image?: { modelId: string; modelName: string };
  video?: { modelId: string; modelName: string };
}

const MEDIA_SELECTION_KV_KEY = 'media_selection';

const MEDIA_ICON_HINTS: Array<{ pattern: RegExp; providerKey: string }> = [
  { pattern: /doubao|seedream|豆包/i, providerKey: 'doubao' },
  { pattern: /minimax/i, providerKey: 'minimax' },
  { pattern: /qwen|qwq|wan2\.7|z-image/i, providerKey: 'qwen' },
];

const resolveMediaModelIcon = (model: MediaModel): React.ReactNode => {
  const text = `${model.displayName} ${model.modelId}`;
  const hint = MEDIA_ICON_HINTS.find(({ pattern }) => pattern.test(text));
  return getProviderIcon(hint?.providerKey ?? '');
};

interface MediaModelPickerProps {
  draftKey: string;
  disabled?: boolean;
}

const MediaModelPicker: React.FC<MediaModelPickerProps> = ({ draftKey, disabled }) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'image' | 'video'>('image');
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const authQuota = useSelector((state: RootState) => state.auth.quota);
  const isSubscribed = isLoggedIn && authQuota?.subscriptionStatus === 'active';

  const mediaModels = useSelector((state: RootState) => state.cowork.mediaModels);
  const selection = useSelector((state: RootState) => state.cowork.mediaSelection[draftKey]);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const fetchModels = useCallback(async () => {
    setIsLoading(true);
    try {
      const [imageResult, videoResult] = await Promise.all([
        window.electron.media.getModels('image'),
        window.electron.media.getModels('video'),
      ]);
      console.log('[MediaModelPicker] fetchModels results:', {
        image: { success: imageResult.success, count: imageResult.models?.length, error: imageResult.error },
        video: { success: videoResult.success, count: videoResult.models?.length, error: videoResult.error },
      });
      if (!imageResult.success) console.warn('[MediaModelPicker] image models fetch failed:', imageResult.error);
      if (!videoResult.success) console.warn('[MediaModelPicker] video models fetch failed:', videoResult.error);
      dispatch(setMediaModels({
        image: (imageResult.models || []) as MediaModel[],
        video: (videoResult.models || []) as MediaModel[],
      }));
      const imageModels = (imageResult.models || []) as MediaModel[];
      const videoModels = (videoResult.models || []) as MediaModel[];
      const currentSelection = selectionRef.current;
      if (!currentSelection || currentSelection.mode === 'none') {
        const saved = await localStore.getItem<SavedMediaSelection>(MEDIA_SELECTION_KV_KEY);
        const imageEntry = saved?.image;
        const videoEntry = saved?.video;
        const imageValid = imageEntry && imageModels.some(m => m.modelId === imageEntry.modelId);
        const videoValid = videoEntry && videoModels.some(m => m.modelId === videoEntry.modelId);

        if (imageValid && videoValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: {
              mode: 'auto',
              modelId: imageEntry.modelId,
              modelName: imageEntry.modelName,
              imageModelId: imageEntry.modelId,
              videoModelId: videoEntry!.modelId,
            },
          }));
        } else if (imageValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: { mode: 'image', modelId: imageEntry.modelId, modelName: imageEntry.modelName },
          }));
        } else if (videoValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: { mode: 'video', modelId: videoEntry!.modelId, modelName: videoEntry!.modelName },
          }));
          setActiveTab('video');
        }
      }
    } catch (err) {
      console.error('[MediaModelPicker] Failed to fetch models:', err);
    } finally {
      setIsLoading(false);
    }
  }, [dispatch, draftKey]);

  useEffect(() => {
    console.log('[MediaModelPicker] useEffect check:', {
      isOpen, isLoggedIn, subscriptionStatus: authQuota?.subscriptionStatus, isSubscribed,
      imageCount: mediaModels.image.length, videoCount: mediaModels.video.length,
    });
    if (isOpen && isSubscribed) {
      fetchModels();
    }
  }, [isOpen, isSubscribed, fetchModels]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    if (selection && selection.mode !== 'none') return;

    let cancelled = false;
    (async () => {
      const saved = await localStore.getItem<SavedMediaSelection>(MEDIA_SELECTION_KV_KEY);
      if (cancelled) return;
      const imageEntry = saved?.image;
      const videoEntry = saved?.video;
      if (imageEntry && videoEntry) {
        dispatch(setMediaSelection({
          draftKey,
          selection: {
            mode: 'auto',
            modelId: imageEntry.modelId,
            modelName: imageEntry.modelName,
            imageModelId: imageEntry.modelId,
            videoModelId: videoEntry.modelId,
          },
        }));
      } else if (imageEntry) {
        dispatch(setMediaSelection({
          draftKey,
          selection: { mode: 'image', modelId: imageEntry.modelId, modelName: imageEntry.modelName },
        }));
      } else if (videoEntry) {
        dispatch(setMediaSelection({
          draftKey,
          selection: { mode: 'video', modelId: videoEntry.modelId, modelName: videoEntry.modelName },
        }));
        setActiveTab('video');
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, dispatch]);

  const handleSelect = async (mode: MediaGenerationMode, model?: MediaModel) => {
    const saved = await localStore.getItem<SavedMediaSelection>(MEDIA_SELECTION_KV_KEY) || {};
    const currentModelId = mode === 'image'
      ? (selection?.imageModelId ?? (selection?.mode === 'image' ? selection?.modelId : undefined))
      : (selection?.videoModelId ?? (selection?.mode === 'video' ? selection?.modelId : undefined));
    const isDeselect = model && currentModelId === model.modelId;

    if (isDeselect) {
      delete saved[mode as 'image' | 'video'];
    } else if (model) {
      saved[mode as 'image' | 'video'] = { modelId: model.modelId, modelName: model.displayName };
    }
    localStore.setItem(MEDIA_SELECTION_KV_KEY, saved);

    const hasImage = !!saved.image;
    const hasVideo = !!saved.video;

    if (hasImage && hasVideo) {
      dispatch(setMediaSelection({
        draftKey,
        selection: {
          mode: 'auto',
          modelId: saved[mode as 'image' | 'video']?.modelId,
          modelName: saved[mode as 'image' | 'video']?.modelName,
          imageModelId: saved.image!.modelId,
          videoModelId: saved.video!.modelId,
        },
      }));
    } else if (hasImage) {
      dispatch(setMediaSelection({
        draftKey,
        selection: { mode: 'image', modelId: saved.image!.modelId, modelName: saved.image!.modelName },
      }));
    } else if (hasVideo) {
      dispatch(setMediaSelection({
        draftKey,
        selection: { mode: 'video', modelId: saved.video!.modelId, modelName: saved.video!.modelName },
      }));
    } else {
      dispatch(setMediaSelection({ draftKey, selection: { mode: 'none' } }));
    }
  };

  const handleLogin = async () => {
    setIsOpen(false);
    await authService.login();
  };

  const handleSubscribe = async () => {
    setIsOpen(false);
    const { getPortalPricingUrl } = await import('../../services/endpoints');
    await window.electron.shell.openExternal(getPortalPricingUrl());
  };

  const currentModels = activeTab === 'image' ? mediaModels.image : mediaModels.video;

  const isMediaActive = selection != null && selection.mode !== 'none';

  const triggerIcon = (
    <MagicIcon className="h-5 w-5" style={{ opacity: isMediaActive ? 1 : 0.5 }} />
  );

  const renderPromptPanel = (title: string, desc: string, btnLabel: string, onBtn: () => void, secondaryLabel?: string, onSecondary?: () => void) => (
    <div className="px-4 py-5">
      <div className="flex justify-center mb-3">
        <Lottie
          animationData={mediaGenAnimation}
          loop={false}
          autoplay={true}
          style={{ width: 80, height: 80 }}
          key={Date.now()}
        />
      </div>
      <div className="text-[13px] font-medium text-foreground text-center">{title}</div>
      <div className="text-[12px] text-secondary mt-1 text-center">{desc}</div>
      <button
        type="button"
        onClick={onBtn}
        className="mt-3 w-full rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary/90 transition-colors"
      >
        {btnLabel}
      </button>
      {secondaryLabel && onSecondary && (
        <div
          onClick={onSecondary}
          className="mt-2 text-center text-[12px] text-secondary hover:text-foreground cursor-pointer transition-colors"
        >
          {secondaryLabel}
        </div>
      )}
    </div>
  );

  const renderDropdownContent = () => {
    if (!isLoggedIn) {
      return renderPromptPanel(
        i18nService.t('mediaLoginTitle'),
        i18nService.t('mediaLoginDesc'),
        i18nService.t('mediaLoginBtn'),
        handleLogin,
        i18nService.t('mediaLearnMore'),
        handleSubscribe,
      );
    }

    if (!isSubscribed) {
      return renderPromptPanel(
        i18nService.t('mediaSubscribeTitle'),
        i18nService.t('mediaSubscribeDesc'),
        i18nService.t('mediaSubscribeBtn'),
        handleSubscribe,
      );
    }

  const handleTabSwitch = (tab: 'image' | 'video') => {
    setActiveTab(tab);
  };

    return (
      <>
        {/* Tabs */}
        <div className="border-b border-border/60 p-2">
          <div className="flex rounded-lg bg-surface-raised p-0.5" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'image'}
              onClick={() => handleTabSwitch('image')}
              className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-[12px] font-medium leading-4 transition-colors ${
                activeTab === 'image'
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              <span className="truncate">{i18nService.t('mediaImage')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'video'}
              onClick={() => handleTabSwitch('video')}
              className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-[12px] font-medium leading-4 transition-colors ${
                activeTab === 'video'
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              <span className="truncate">{i18nService.t('mediaVideo')}</span>
            </button>
          </div>
        </div>

        {/* Model List */}
        <div className="max-h-72 overflow-y-auto py-1">
          {isLoading ? (
            <div className="px-2 py-3 text-center text-xs text-secondary">
              {i18nService.t('mediaLoadingModels')}
            </div>
          ) : currentModels.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-secondary">
              {i18nService.t('mediaNoModels')}
            </div>
          ) : (
            currentModels.map((model) => {
              const isSelected = activeTab === 'image'
                ? (selection?.imageModelId === model.modelId || (selection?.mode === 'image' && selection?.modelId === model.modelId))
                : (selection?.videoModelId === model.modelId || (selection?.mode === 'video' && selection?.modelId === model.modelId));
              return (
                <button
                  key={model.modelId}
                  type="button"
                  onClick={() => handleSelect(activeTab, model)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-background/80 ${isSelected ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
                >
                  <span className="shrink-0 h-4 w-4 [&_svg]:h-4 [&_svg]:w-4">{resolveMediaModelIcon(model)}</span>
                  <span className="min-w-0 truncate font-medium">{model.displayName}</span>
                  {isSelected && (
                    <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500 ml-auto" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </>
    );
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex h-[34px] w-[34px] items-center justify-center rounded-lg transition-colors ${
          selection && selection.mode !== 'none'
            ? 'text-foreground hover:bg-surface-raised'
            : 'text-secondary hover:bg-surface-raised hover:text-foreground'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {triggerIcon}
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 z-50 mb-1 w-60 rounded-xl border border-border bg-surface shadow-popover overflow-hidden"
        >
          {renderDropdownContent()}
        </div>
      )}
    </div>
  );
};

export default MediaModelPicker;
