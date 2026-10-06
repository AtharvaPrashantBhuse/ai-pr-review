import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const tokenUsages = await prisma.tokenUsage.findMany({
      orderBy: {
        id: "asc",
      },
    });

    return NextResponse.json(tokenUsages);
  } catch (error) {
    console.error("Failed to fetch token usage:", error);

    return NextResponse.json(
      { error: "Failed to fetch token usage" },
      { status: 500 }
    );
  }
}