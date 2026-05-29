/**
 * 原有类型定义（从 types.ts 迁移过来）
 */
export type AspectRatio = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16';

export type Duration = 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export type ModelId = 'seedance-2.0' | 'seedance-2.0-vip' | 'seedance-2.0-fast' | 'seedance-2.0-fast-vip' | 'seedance-1.5-pro' | 'seedance-1.0-pro' | string;

// ============================================================
// 用户认证类型
// ============================================================

export interface User {
  id: number;
  email: string;
  role: 'user' | 'admin' | 'super_admin';
  status: 'active' | 'disabled';
  credits: number;
  unlimitedCredits?: boolean;
  /** 用户姓名（首次登录补填，2~20 字符） */
  name?: string | null;
  /** 用户小组（首次登录补填，从字典表挑选或新建；仅管理员可改） */
  department?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastCheckInAt?: string;
  permissions?: Record<string, boolean>;
}

export interface Department {
  id: number;
  name: string;
}

export interface FeatureKey {
  key: string;
  label: string;
  defaultEnabled: boolean;
}

export interface ModelPricing {
  model_key: string;
  label: string;
  pricing_type: 'seedance2' | 'seedance15';
  price_no_video_low: number;
  price_no_video_high: number;
  price_with_video_low: number;
  price_with_video_high: number;
  price_audio: number;
  price_silent: number;
  draft_factor_audio: number;
  draft_factor_silent: number;
  default_fps: number;
  enabled: number;
  sort_order: number;
  description: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterCredentials {
  email: string;
  password: string;
  emailCode?: string;
}

export interface AuthResponse {
  sessionId: string;
  user: User;
}

export interface ModelOption {
  value: ModelId;
  label: string;
  description: string;
}

export interface AppViewOption {
  id: AppView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
}

export enum AppView {
  LOGIN = 'LOGIN',
  REGISTER = 'REGISTER',
  SINGLE_TASK = 'SINGLE_TASK',
  DOWNLOAD_MANAGEMENT = 'DOWNLOAD_MANAGEMENT',
  SETTINGS = 'SETTINGS',
  ADMIN = 'ADMIN',
  PROFILE = 'PROFILE',
}

export type ReferenceMode = 'reference' | 'first_last_frame';

export interface FrameReferenceFlags {
  firstFrameProvided?: boolean;
  lastFrameProvided?: boolean;
}

export interface UploadedImage {
  id: string;
  file: File;
  previewUrl: string;
  index: number;
}

export interface UploadedFile {
  id: string;
  file: File;
  previewUrl: string;   // objectURL for images/videos, '' for audio
  name: string;
  size: number;
  mediaType: 'image' | 'video' | 'audio';
  ossUrl?: string;      // set after OSS upload
  uploadProgress?: number; // 0-100
}

export interface GenerateVideoRequest {
  prompt: string;
  model: ModelId;
  ratio: AspectRatio;
  duration: Duration;
  files: File[];         // legacy direct upload
  imageUrls?: string[];  // OSS image URLs
  videoUrl?: string;     // OSS video URL
  audioUrl?: string;     // OSS audio URL
  batchSize?: number;    // 批量生成数量（>1 时后端返回 taskIds 数组）
}

export interface VideoGenerationResponse {
  created: number;
  data: Array<{
    url: string;
    revised_prompt: string;
  }>;
}

export type GenerationStatus = 'idle' | 'generating' | 'success' | 'error';

export interface GenerationState {
  status: GenerationStatus;
  progress?: string;
  result?: VideoGenerationResponse;
  error?: string;
}

export interface RatioOption {
  value: AspectRatio;
  label: string;
  widthRatio: number;
  heightRatio: number;
}

export const RATIO_OPTIONS: RatioOption[] = [
  { value: '21:9', label: '21:9', widthRatio: 21, heightRatio: 9 },
  { value: '16:9', label: '16:9', widthRatio: 16, heightRatio: 9 },
  { value: '4:3', label: '4:3', widthRatio: 4, heightRatio: 3 },
  { value: '1:1', label: '1:1', widthRatio: 1, heightRatio: 1 },
  { value: '3:4', label: '3:4', widthRatio: 3, heightRatio: 4 },
  { value: '9:16', label: '9:16', widthRatio: 9, heightRatio: 16 },
];

export const DURATION_OPTIONS: Duration[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

export const REFERENCE_MODES: ReferenceMode[] = ['reference', 'first_last_frame'];

/**
 * @deprecated 仅作为运行时拉取 /api/model-pricing 失败时的兜底；正常情况下使用 listEnabledModels()
 */
export const MODEL_OPTIONS: ModelOption[] = [
  // {
  //   value: 'seedance-2.0',
  //   label: 'Seedance 2.0',
  //   description: '全能模型，支持文生视频和图生视频',
  // },
  {
    value: 'seedance-2.0-fast',
    label: 'Seedance 2.0 Fast',
    description: '快速模型，生成速度更快',
  },
  // {
  //   value: 'seedance-1.5-pro',
  //   label: 'Seedance 1.5 Pro',
  //   description: '专业模型，适合高质量场景',
  // },
];

/**
 * 项目管理相关类型定义（新增）
 */

/**
 * 项目
 */
export interface Project {
  id: number;
  name: string;
  description?: string;
  settings_json?: string;
  user_id?: number;
  task_count?: number;
  completed_count?: number;
  member_count?: number;
  my_role?: 'owner' | 'admin' | 'member';
  volc_id?: number | null;
  volc_name?: string;
  volc_is_active?: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * 项目设置
 */
export interface ProjectSettings {
  model?: string;
  ratio?: string;
  duration?: number;
  referenceMode?: string;
}

/**
 * 任务
 */
export interface Task {
  id: number;
  project_id: number;
  user_id?: number;
  prompt: string;
  status: TaskStatus;
  submit_id?: string | null;
  history_id?: string | null;
  item_id?: string | null;
  video_url?: string | null;
  video_path?: string | null;
  download_status?: DownloadStatus | null;
  download_path?: string | null;
  downloaded_at?: string | null;
  submitted_at?: string | null;
  account_info?: string | null;
  progress?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string | null;
  retry_count?: number;
  project_name?: string;
  created_by_email?: string;
  assets?: TaskAsset[];
}

/**
 * 任务状态
 */
export type TaskStatus =
  | 'pending'     // 等待中
  | 'generating'  // 生成中
  | 'done'        // 已完成
  | 'error'       // 出错
  | 'cancelled';  // 已取消

/**
 * 任务素材
 */
export interface TaskAsset {
  id: number;
  task_id: number;
  asset_type: 'image' | 'audio';
  file_path: string;
  image_uri?: string;
  sort_order: number;
}

/**
 * 全局设置
 */
export interface Settings {
  model?: string;
  ratio?: string;
  duration?: string;
  resolution?: string;
  reference_mode?: string;
  download_path?: string;
  max_concurrent?: string;
  min_interval?: string;
  max_interval?: string;
}

/**
 * API 响应
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * 生成历史
 */
export interface GenerationHistory {
  id: number;
  task_id: number;
  batch_id?: string;
  request_data?: string;
  response_data?: string;
  created_at: string;
}

/**
 * 下载管理相关类型定义（新增）
 */

/**
 * 下载状态
 */
export type DownloadStatus =
  | 'pending'     // 待下载
  | 'downloading' // 下载中
  | 'done'        // 已下载
  | 'failed'      // 下载失败
  | 'generating'; // 生成中

/**
 * 下载任务
 */
export interface DownloadTask {
  id: number;
  prompt: string;
  model?: string;
  ratio?: string;
  duration?: string;
  resolution?: string;
  status: TaskStatus;
  download_status: DownloadStatus;
  video_url?: string;
  image_urls?: string[];
  video_path?: string;
  download_path?: string;
  downloaded_at?: string;
  account_info?: string;
  submit_id?: string;
  history_id?: string;
  created_at: string;
  completed_at?: string;
  error_message?: string | null;
  project_id?: number;
  project_name?: string;
  hasHistory: boolean;
  model_type: 'image' | 'video' | 'audio' | 'enhancement' | 'happyhorse';
  effective_download_status: DownloadStatus;
  assets?: Array<{ assetType: string; uri: string; originalName?: string | null }>;
  credits_used?: number;
  enhancements?: VideoEnhancement[];
  // 音频行专用：参考图缩略图，浏览器端 mp4→mp3 转码使用 video_url
  reference_image_url?: string;
  // HappyHorse 行专用：子模式 + 显示标签（用于卡片副标题）
  happyhorse_mode?: 't2v' | 'i2v' | 'r2v' | 'video-edit';
  happyhorse_mode_label?: string;
  // 批量生成专用
  concurrent_id?: string | null;
  concurrent_items?: DownloadTask[];
}

/**
 * 视频画质增强记录（火山 AI MediaKit）
 *
 * 输出分辨率有两种二选一的表达方式：
 *   - target_resolution：预设档（240p/360p/480p/540p/720p/1080p/2k/4k）
 *   - resolution_limit：短边像素 [64, 2160]，等比缩放
 */
export type EnhancementResolutionPreset = '240p' | '360p' | '480p' | '540p' | '720p' | '1080p' | '2k' | '4k';

export interface VideoEnhancement {
  id: number;
  task_id: number | null;
  status: 'pending' | 'processing' | 'done' | 'error';
  tool_version: 'standard' | 'professional';
  scene: 'aigc' | 'short_series' | 'ugc' | 'old_film' | 'common';
  target_resolution: EnhancementResolutionPreset | null;
  resolution_limit?: number | null;
  target_fps?: number;
  source_video_url?: string | null;
  enhanced_video_url?: string | null;
  result_resolution?: string | null;
  result_fps?: number | null;
  error_message?: string | null;
  credits_used?: number;
  duration_seconds?: number;
  created_at: string;
  finished_at?: string | null;
}

/**
 * 画质增强计费配置
 *
 * 与 MediaKit 官方计费规则一致：
 *   credits = ceil(durationMinutes × coefficient × baseCreditsPerMinute)
 * 系数表由 (tool_version, resolution_tier, fps_tier) 决定，基础单价 admin 可调。
 */
export interface EnhancementCoefficient {
  tool_version: 'standard' | 'professional';
  resolution_tier: '720p' | '1080p' | '2k' | '4k';
  fps_tier: 'le30' | 'gt30';
  coefficient: number;
}

export interface EnhancementPricing {
  baseCreditsPerMinute: number;
  coefficients: EnhancementCoefficient[];
}

/**
 * 音频生成记录（参考图 + 语气提示词 → 4s seedance 视频 → 浏览器端转 mp3）
 */
export interface AudioGeneration {
  id: number;
  task_id: number | null;
  user_id: number;
  project_id: number | null;
  reference_image_url: string;
  voice_prompt: string;
  status: 'pending' | 'generating' | 'done' | 'error';
  intermediate_video_url: string | null;
  credits_used: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  // JOIN 自 tasks 表的辅助字段（仅 list 接口返回）
  task_status?: string | null;
  task_video_url?: string | null;
  task_progress?: string | null;
}

/**
 * HappyHorse 视频生成（阿里云百炼 DashScope）
 */
export type HappyhorseMode = 't2v' | 'i2v' | 'r2v' | 'video-edit';
export type HappyhorseResolution = '720P' | '1080P';
export type HappyhorseRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '4:5' | '5:4';
export type HappyhorseStatus = 'pending' | 'processing' | 'done' | 'error' | 'canceled';

export interface HappyhorseMediaItem {
  type: 'first_frame' | 'reference_image' | 'video';
  url: string;
  original_name?: string | null;
}

export interface HappyhorseTask {
  id: number;
  user_id: number;
  project_id: number;
  mode: HappyhorseMode;
  model: string;
  prompt: string;
  ratio: HappyhorseRatio | null;
  duration: number | null;
  resolution: HappyhorseResolution;
  media: HappyhorseMediaItem[];
  watermark: number;
  audio_setting: 'auto' | 'origin' | null;
  seed: number | null;
  status: HappyhorseStatus;
  dashscope_task_id: string | null;
  request_id: string | null;
  video_url: string | null;
  video_path: string | null;
  download_status: string | null;
  download_path: string | null;
  downloaded_at: string | null;
  result_duration: number | null;
  result_output_duration: number | null;
  result_input_duration: number | null;
  result_resolution: number | null;
  result_ratio: string | null;
  credits_used: number;
  error_message: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  concurrent_id?: string | null;
  concurrent_items?: HappyhorseTask[];
}

export interface HappyhorsePricingItem {
  mode: HappyhorseMode;
  model: string;
  resolution: HappyhorseResolution;
  credits_per_second: number;
}

/**
 * 下载任务列表（分页）
 */
export interface DownloadTaskList {
  tasks: DownloadTask[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 项目资产
 */
export interface ProjectAsset {
  id: number;
  project_id: number;
  asset_group_id?: number;
  volc_asset_id?: string;
  volc_group_id?: string;   // ARK GroupId，用于前端分组
  /** 该素材所属素材组在本地的权威名（已去重）；列表接口实时填充 */
  group_name?: string | null;
  name: string;
  description?: string;
  file_type: 'image' | 'video' | 'audio';
  file_size?: number;
  file_url?: string;
  thumbnail_url?: string;
  status: 'pending' | 'uploading' | 'active' | 'rejected' | 'deleted';
  review_status: 'pending' | 'approved' | 'rejected';
  auto_inject: boolean;
  uploaded_by?: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectAssetList {
  assets: ProjectAsset[];
  total: number;
  page: number;
  pageSize: number;
}

/** 项目素材组（asset_groups 表） */
export interface AssetGroupInfo {
  id: number;
  project_id: number;
  volc_group_id: string | null;
  volc_id: number | null;
  name: string;
  description: string;
  asset_count: number;
  preview_url: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 使用量日志
 */
export interface UsageLog {
  id: number;
  user_id: number;
  task_id?: number;
  model: string;
  action: string;
  credits_cost: number;
  status: 'success' | 'failed';
  error_message?: string;
  created_at: string;
}

export interface UsageStats {
  model: string;
  action: string;
  call_count: number;
  total_credits: number;
  success_count: number;
  failed_count: number;
}

/**
 * 项目成员
 */
export interface ProjectMember {
  id: number;
  project_id: number;
  user_id: number;
  role: 'owner' | 'admin' | 'member';
  email?: string;
  user_role?: string;
  created_at: string;
}
