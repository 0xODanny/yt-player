import { NextRequest, NextResponse } from "next/server";

import { createFakeJob } from "@/lib/jobs";
import { validateJobRequest } from "@/lib/validators";

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as {
      url?: string;
      format?: string;
      quality?: string;
    };

    const validation = validateJobRequest(payload);

    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const job = createFakeJob(validation.data);
    return NextResponse.json(job, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload." },
      { status: 400 },
    );
  }
}