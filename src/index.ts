/**
 * A URL Shortener using Cloudflare Workers, KV & Analytics Engine
 * Uses SHA-512 & SHA-256 to create short url
 * While virtually unlikely, it is liable to the Birthday Paradox/Problem
 * Uses KV (Key = Short URL Hash, Value = Original URL) 
 * Uses Analytics Engine to count each time hash is used
 * Designed for use with Cloudflare Zero Trust exposing endpoint 's' only.
 */
export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			// Takes the incoming request url string into a URL Object 
			const requestURL = new URL(request.url);

			// Splits the URL path by the '/' character and removes the first element
			const pathArray = requestURL.pathname.split('/').splice(1);

			// Endpoint Switch [ p - Creates new Short URL, S - Finds & Redirects to True URL, L - Lists all active Short URLs, default - Not Found ]
			switch(pathArray[0]) {
				case 'p': {
					// Gets the URL to Shorten. Fails if not provided.
					const url = requestURL.searchParams.get("url");
					if(url == null) { return new Response("No URL Provided", { status: 400 }); }

					//Encodes the URL String for Digest using SHA-512 and SHA-256
					const encodedURL = new TextEncoder().encode(url);
					const hash512 = ConvertToHex(await crypto.subtle.digest({ name: "SHA-512" }, encodedURL));
					const hash256 = ConvertToHex(await crypto.subtle.digest({ name: "SHA-256" }, encodedURL));

					//Piece together a Character String. Default is 4 characters per hash.
					const characterSlice = parseInt(env.CHARACTER_SLICE??"4");
					const hash = `${hash256.slice(0, clamp(characterSlice, 1, 64))}${hash512.slice(-clamp(characterSlice, 1, 128))}`;

					//Check if we already have this hash, if not, write to KV with Hash and URL
					const exists = await env.kv.get(hash);
					if(exists == null) { await env.kv.put(hash, url); }
					else {
						//Check for a Possible Hash Collision
						if(exists != url) {
							console.error(`A collision has occurred! These URLs produce the same hash: ${exists} & ${url}`);
							return new Response("A collision has occurred!", { status: 409 })
						}
					}

					//Create the short URL based on current product cycle
					const shortURL = `${env.NODE_ENV === "development" ? `http://localhost:8787` : `https://${requestURL.hostname}`}/s/${hash}`

					//Return 201 with the new Short URL & Original URL 
					return new Response(`Accepted.\nShort URL: ${shortURL}\nOriginal URL: ${url}`, { status: 201 });
				}
				case 's':
					//Get the Hash from the second part of the endpoint. Fails if not provided.
					const hash = pathArray[1];
					if(hash == null) { return new Response("No UUID Provided", { status: 400 }); }

					//Protection against spamming the same hash
					if(!(await env.rateLimit.limit({ key: hash })).success) { return new Response("URL currently rate limited!", { status: 429 }); }

					//Check if it exists. If not, return 404
					const result = await env.kv.get(hash);
					if(result == null) { return new Response("Not Found", { status: 404 }); }

					//Writes each request to Analytics Engine
					env.aed.writeDataPoint({
						indexes: [hash],
						blobs: [result],
						doubles: [1]
					});

					//If found, redirect the user.
					return Response.redirect(result, 302);
				case 'l':
					//Get a List of all the keys
					const list = await env.kv.list();

					//Promise All & Map over the list providing the Short URL to the Original 
					const output = (await Promise.all(list.keys.map(async (v) => {
						return `${env.NODE_ENV === "development" ? `http://localhost:8787` : `https://${requestURL.hostname}`}/s/${v.name} -> ${await env.kv.get(v.name)}\n\n`;
					}))).join('');

					//Return this output to the user
					return new Response(output, { status: 200 });
				default: return new Response("Not Found", { status: 404 });
			}
		} catch(e) {
			//Something went wrong.
			console.log(e); return new Response("Server Error", { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;


/**
 * Converts an incoming digest into a Hexadecimal string
 * @param digest - The output buffer from Algorithmic Digest of data
 * @returns A Hexadecimal String
 */
const ConvertToHex = (digest : ArrayBuffer) => [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');

const clamp = (num : number, min : number, max : number) => { 
	if(num < min) return min
	else if(num > max) return max
	else return num
}