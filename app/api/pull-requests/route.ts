import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const pullRequests = await prisma.pullRequest.findMany({
      orderBy: {
        id: "asc",
      },
    });

    return NextResponse.json(pullRequests);
  } catch (error) {
    console.error("Failed to fetch pull requests:", error);

    return NextResponse.json(
      { error: "Failed to fetch pull requests" },
      { status: 500 }
    );
  }
}