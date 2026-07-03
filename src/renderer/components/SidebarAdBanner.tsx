import React, { useEffect, useMemo, useState } from 'react';

import { getPortalInvitationUrl } from '../services/endpoints';
import { i18nService } from '../services/i18n';
import {
  type ClientBanner,
  getSidebarBannerStorageKey,
  readSidebarBannerDismissState,
  saveSidebarBannerDismissState,
  shouldShowSidebarBanner,
} from './sidebarAdBannerState';

const SidebarAdBanner: React.FC = () => {
  const [banners, setBanners] = useState<ClientBanner[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [hiddenKey, setHiddenKey] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let isCurrent = true;

    const loadBanner = async () => {
      try {
        const result = await window.electron.auth.getActiveClientBanners();
        if (!isCurrent) return;
        if (result.success && Array.isArray(result.data)) {
          setBanners(result.data as ClientBanner[]);
          setCurrentIndex(0);
        } else {
          setBanners([]);
        }
      } catch {
        if (isCurrent) setBanners([]);
      }
    };

    void loadBanner();
    return () => {
      isCurrent = false;
    };
  }, []);

  const storageKey = useMemo(() => (
    banners.length > 0 ? getSidebarBannerStorageKey(banners) : null
  ), [banners]);

  useEffect(() => {
    if (!storageKey) {
      setHiddenKey(null);
      return;
    }
    let isCurrent = true;
    setHiddenKey(undefined);

    const loadDismissState = async () => {
      const dismissState = await readSidebarBannerDismissState(storageKey);
      if (isCurrent) {
        setHiddenKey(shouldShowSidebarBanner(dismissState) ? null : storageKey);
      }
    };

    void loadDismissState();
    return () => {
      isCurrent = false;
    };
  }, [storageKey]);

  useEffect(() => {
    if (banners.length <= 1 || !storageKey || hiddenKey === undefined || hiddenKey === storageKey) {
      return;
    }
    const timer = window.setInterval(() => {
      setCurrentIndex((index) => (index + 1) % banners.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [banners.length, hiddenKey, storageKey]);

  const banner = banners.length > 0 ? banners[currentIndex % banners.length] : null;

  if (!banner || !storageKey || hiddenKey === undefined || hiddenKey === storageKey) {
    return null;
  }

  const dismiss = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setHiddenKey(storageKey);
    void saveSidebarBannerDismissState(storageKey).catch(() => {
      setHiddenKey(storageKey);
    });
  };

  const openBanner = async () => {
    await window.electron.shell.openExternal(banner.linkUrl || getPortalInvitationUrl());
  };

  const imageAspectRatio = banner.imageWidth && banner.imageHeight
    ? `${banner.imageWidth} / ${banner.imageHeight}`
    : '16 / 5';

  return (
    <div className="pb-1">
      <div
        role="button"
        tabIndex={0}
        onClick={() => void openBanner()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openBanner();
          }
        }}
        className="group relative block w-full overflow-hidden rounded-none transition-opacity hover:opacity-95"
        style={{ aspectRatio: imageAspectRatio }}
        aria-label={banner.activityDescription}
      >
        <img
          src={banner.imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          aria-hidden="true"
        />
        <button
          type="button"
          aria-label={i18nService.t('close')}
          onClick={dismiss}
          onKeyDown={(event) => event.stopPropagation()}
          className="absolute right-1 top-1 z-20 hidden h-5 w-5 items-center justify-center rounded-full bg-black/20 text-xs leading-none text-white transition-colors hover:bg-black/35 group-hover:flex group-focus-within:flex"
        >
          ×
        </button>
      </div>
    </div>
  );
};

export default SidebarAdBanner;
