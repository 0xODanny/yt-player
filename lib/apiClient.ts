export type JobPayload = {
  url: string;
  format: "mp3" | "mp4";
  quality:
    | "best"
    | "1080p"
    | "720p"
    | "480p"
    | "360p"
    | "240p"
    | "144p"
    | "audio-only";
};

export type JobStatus = "queued" | "processing" | "complete" | "failed";

export type JobMetadataFormat = {
  itag: number;
  container: string;
  quality: string;
  hasAudio: boolean;
  hasVideo: boolean;
};

export type JobMetadata = {
  title?: string;
  duration?: number | null;
  formats?: JobMetadataFormat[];
  author?: string;
  thumbnail?: string;
};

export type JobResponse = {
  id: string;
  status: JobStatus;
  message: string;
};

export type JobStatusResponse = {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  metadata?: JobMetadata;
  downloadUrl?: string;
};

export type JobErrorResponse = {
  error?: string;
};

type EndpointConfig = {
  url: string;
  isExternal: boolean;
};

function getJobsEndpoint(): EndpointConfig {
  const workerUrl = process.env.NEXT_PUBLIC_WORKER_API_URL?.trim();

  if (!workerUrl) {
    return {
      url: "/api/jobs",
      isExternal: false,
    };
  }

  return {
    url: `${workerUrl.replace(/\/$/, "")}/jobs`,
    isExternal: true,
  };
}

function getJobEndpoint(jobId: string) {
  const endpoint = getJobsEndpoint();

  return {
    ...endpoint,
    url: `${endpoint.url}/${jobId}`,
  };
}

function getRequestHeaders(isExternal: boolean) {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  if (!isExternal) {
    return headers;
  }

  const apiKey = process.env.NEXT_PUBLIC_WORKER_API_KEY?.trim();

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function normalizeErrorResponse(
  response: Response,
  data: JobResponse | JobStatusResponse | JobErrorResponse,
) {
  if (response.status === 401 || response.status === 403) {
    return {
      error: "Worker access denied. Check API key.",
    } satisfies JobErrorResponse;
  }

  return data;
}

export async function createJob(payload: JobPayload) {
  const endpoint = getJobsEndpoint();
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: getRequestHeaders(endpoint.isExternal),
    body: JSON.stringify(payload),
  });

  const data = normalizeErrorResponse(
    response,
    (await response.json()) as JobResponse | JobErrorResponse,
  ) as JobResponse | JobErrorResponse;

  return {
    response,
    data,
  };
}

export async function getJob(jobId: string) {
  const endpoint = getJobEndpoint(jobId);
  const response = await fetch(endpoint.url, {
    method: "GET",
    headers: getRequestHeaders(endpoint.isExternal),
  });

  const data = normalizeErrorResponse(
    response,
    (await response.json()) as JobStatusResponse | JobErrorResponse,
  ) as JobStatusResponse | JobErrorResponse;

  return {
    response,
    data,
  };
}