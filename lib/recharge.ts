const RECHARGE_API_URL = "https://api.rechargeapps.com";

const token: string = process.env.RECHARGE_API_TOKEN ?? "";

if (!token) {
  throw new Error("RECHARGE_API_TOKEN is missing");
}

export async function rechargeFetch(
  path: string,
  options: RequestInit = {}
) {
  const response = await fetch(`${RECHARGE_API_URL}${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      "X-Recharge-Access-Token": token,
      "X-Recharge-Version":
        process.env.RECHARGE_API_VERSION || "2021-11",
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error("Recharge API error:", {
      status: response.status,
      data,
    });

    throw new Error(
      `Recharge API returned ${response.status}: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}
