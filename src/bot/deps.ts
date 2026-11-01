import { Markup } from 'telegraf';
import { config, isAdmin } from '../config.ts';
import { normalizeCode, extractCodes, cleanActressList, cleanTitle } from '../services/code.ts';
import { searchVideos, getVideoById, getVideoByCode, upsertVideoFromProvider, countVideos, updateVideoMetadata, deleteVideo, updateVideoStatus } from '../services/videos.ts';
import { createIndexJob, countJobs, getRecentJobs, retryJob } from '../services/indexJobs.ts';
import { upsertUser, isUserBlocked, setUserBlocked, countUsers, getBroadcastUserIds, getBroadcastRecipientPage, getUser, getUserDashboard, getReferralLeaderboard, redeemPromoCode, createPromoCode, listPremiumPayments, listPromoCodes, setPromoCodeActive, completeStarPremiumPayment, consumeVideoDownload, refundVideoDownload, getDownloadQuotaSettings, setDownloadQuotaSettings, registerReferral, completeReferral, setUserPlan } from '../services/users.ts';
import { checkUserForceSub, getAllForceSubChannels, upsertForceSubChannel, updateForceSubChannel, deleteForceSubChannel, createForceSubInviteLink } from '../services/forceSub.ts';
import { getAdminSession, setAdminSession, clearAdminSession } from '../services/adminSessions.ts';
import { javtifulProvider } from '../providers/javtiful/index.ts';
import { sendDumpVideoToUser, storeThumbnailInDumpChannel } from '../services/dump.ts';
import { installMessageDeleteTimer } from '../services/messageDeleteTimer.ts';
import { getSetting, setSetting } from '../services/settings.ts';
import { classifyTelegramError, withTelegramRetry } from '../services/telegramErrors.ts';
import { recordVideoDeliveryEvent, getVideoDeliveryAnalytics } from '../services/videoAnalytics.ts';
import { deliverVideoToUser, showAdminVideoEditMenu, sendReferralLeaderboard, sendUserPlan, sendReferralInfo, escapeHtml, handleSearchQuery, showForceSubAdminMenu, showAdminSettings, formatTimer } from './helpers.ts';
import { getPremiumPackages, savePremiumPackage, removePremiumPackage, togglePremiumPackage, parsePremiumPayload, sendPremiumStore, sendPremiumInvoice } from './premium.ts';

export const botDeps = {
  Markup, config, isAdmin, normalizeCode, extractCodes, cleanActressList, cleanTitle,
  searchVideos, getVideoById, getVideoByCode, upsertVideoFromProvider, countVideos, updateVideoMetadata, deleteVideo, updateVideoStatus,
  createIndexJob, countJobs, getRecentJobs, retryJob,
  upsertUser, isUserBlocked, setUserBlocked, countUsers, getBroadcastUserIds, getBroadcastRecipientPage, getUser, getUserDashboard, getReferralLeaderboard,
  redeemPromoCode, createPromoCode, listPremiumPayments, listPromoCodes, setPromoCodeActive, completeStarPremiumPayment,
  consumeVideoDownload, refundVideoDownload, getDownloadQuotaSettings, setDownloadQuotaSettings, registerReferral, completeReferral, setUserPlan,
  checkUserForceSub, getAllForceSubChannels, upsertForceSubChannel, updateForceSubChannel, deleteForceSubChannel, createForceSubInviteLink,
  getAdminSession, setAdminSession, clearAdminSession, javtifulProvider, sendDumpVideoToUser, storeThumbnailInDumpChannel,
  installMessageDeleteTimer, getSetting, setSetting, classifyTelegramError, withTelegramRetry, recordVideoDeliveryEvent, getVideoDeliveryAnalytics,
  deliverVideoToUser, showAdminVideoEditMenu, sendReferralLeaderboard, sendUserPlan, sendReferralInfo, escapeHtml, handleSearchQuery,
  showForceSubAdminMenu, showAdminSettings, formatTimer, getPremiumPackages, savePremiumPackage, removePremiumPackage, togglePremiumPackage, parsePremiumPayload, sendPremiumStore, sendPremiumInvoice,
};
