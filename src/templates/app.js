export const getMainTsx = (title, webviewPath = 'index.html') => {
  const safeTitle = title.replace(/'/g, "\\'");
  return `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel, useAsync } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
});

Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    const [key, setKey] = useState(0);
    const [lastProcessedReqId, setLastProcessedReqId] = useState(0);
    
    // Request State for server-side async operations (Bridge for Redis)
    const [serverReq, setServerReq] = useState({ id: 0, type: '', payload: null });

    // Server-Side Processor
    // This hook runs on the server/worker when 'serverReq.id' changes.
    // It solves "ServerCallRequired" errors by ensuring Redis is accessed from the correct context.
    const { data: serverResponse } = useAsync(async () => {
      if (!serverReq.type || serverReq.id === 0) return null;
      
      const { type, payload } = serverReq;
      const collectionName = payload.collection || 'default';
      const redisKey = \`websim:data:\${collectionName}\`;

      try {
          // Explicitly check context availability
          if (!context || !context.redis) {
              throw new Error('Redis context unavailable inside useAsync');
          }

          if (type === 'db_load') {
              const data = await context.redis.hGetAll(redisKey);
              const count = data ? Object.keys(data).length : 0;
              console.log(\`[Redis] Loaded \${count} records for \${collectionName}\`);
              return { 
                  reqId: serverReq.id, 
                  success: true, 
                  action: 'send_dump',
                  data: {
                      type: 'WEBSIM_SOCKET_EVT',
                      payload: {
                          type: 'db_dump',
                          collection: collectionName,
                          data: data || {}
                      }
                  }
              };
          }

          if (type === 'batch_load') {
              const results = {};
              const collections = payload.collections || [];
              console.log(\`[Redis] Batch loading \${collections.length} collections...\`);
              
              for (const name of collections) {
                  const key = \`websim:data:\${name}\`;
                  try {
                      const data = await context.redis.hGetAll(key);
                      results[name] = data || {};
                  } catch(e) {
                      results[name] = {};
                  }
              }
              return { 
                  reqId: serverReq.id, 
                  success: true, 
                  action: 'send_batch_dump', 
                  data: results 
              };
          }
          
          if (type === 'db_op') {
              if (payload.cmd === 'create' || payload.cmd === 'update') {
                  await context.redis.hSet(redisKey, { [payload.data.id]: JSON.stringify(payload.data) });
              } else if (payload.cmd === 'delete') {
                  await context.redis.hDel(redisKey, [payload.data.id]);
              }
              // Return info to trigger broadcast
              return { reqId: serverReq.id, success: true, action: 'broadcast_op', payload };
          }
      } catch (e) {
          console.error('[Redis] Server Operation Error:', e);
          // Return failure but with ID so we stop retry loops
          return { reqId: serverReq.id, success: false, error: String(e) };
      }
      return null;
    }, { depends: [serverReq.id] });

    // Realtime Channel Bridge
    const channel = useChannel({
      name: 'websim_global',
      onMessage: (msg) => {
        context.ui.webView.postMessage('gameview_' + key, {
          type: 'WEBSIM_SOCKET_EVT',
          payload: msg
        });
      },
    });

    channel.subscribe();

    // Effect-like Logic: Handle Async Response
    // We strictly check reqId to avoid reprocessing
    if (serverResponse && serverResponse.reqId !== lastProcessedReqId) {
        setLastProcessedReqId(serverResponse.reqId);
        
        if (serverResponse.success) {
            if (serverResponse.action === 'send_dump') {
                context.ui.webView.postMessage('gameview_' + key, serverResponse.data);
            } else if (serverResponse.action === 'send_batch_dump') {
                context.ui.webView.postMessage('gameview_' + key, {
                    type: 'WEBSIM_SOCKET_EVT',
                    payload: {
                        type: 'batch_dump',
                        data: serverResponse.data
                    }
                });
            } else if (serverResponse.action === 'broadcast_op') {
                // Broadcast change via Realtime
                channel.send({
                    type: 'db_sync',
                    collection: serverResponse.payload.collection,
                    op: serverResponse.payload
                });
            }
        } else {
           console.error(\`[WebSim] Server Request Failed: \${serverResponse.error || 'Unknown'}\`);
        }
    }

    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id={'gameview_' + key}
          grow
          url="${webviewPath}"
          width="100%"
          height="100%"
          key={key.toString()}
          onMessage={async (event) => {
            let msg = event;
            if (typeof msg === 'string') {
              try { msg = JSON.parse(msg); } catch (e) {}
            }
            if (!msg || typeof msg !== 'object') return;

            // 0. Handle Handshake (WebView Ready)
            if (msg.type === 'webViewReady') {
                const collections = msg.payload?.collections || [];
                setServerReq({
                    id: Math.random(),
                    type: 'batch_load',
                    payload: { collections }
                });
                return;
            }

            // 0.5 Handle User Context Request
            if (msg.type === 'get_user_context') {
              try {
                const currUser = await context.reddit.getCurrentUser();
                context.ui.webView.postMessage('gameview_' + key, JSON.stringify({
                  type: 'set_user_context',
                  payload: {
                    id: currUser.id,
                    username: currUser.username,
                    avatar_url: currUser.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                  }
                }));
              } catch (e) {
                context.ui.webView.postMessage('gameview_' + key, JSON.stringify({
                  type: 'set_user_context',
                  payload: {
                    id: 'anon',
                    username: 'Anonymous',
                    avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                  }
                }));
              }
              return;
            }

            // 1. Handle Socket/Redis messages
            if (msg.type === 'WEBSIM_SOCKET_MSG') {
              const { type, payload } = msg.payload || {};

              // A. Database Operations -> Bridge to Server via State
              if (type === 'db_op' || type === 'db_load') {
                  // We generate a random ID to track this request
                  setServerReq({
                      id: Math.random(),
                      type: type,
                      payload: payload
                  });
              }

              // B. Standard Realtime Relay (Broadcast)
              // This is safe to run on Client
              else {
                try {
                  await channel.send(msg.payload);
                } catch (e) {
                  // Suppress 'not connected'
                }
              }
            }
            
            // 2. Handle Console Logs
            if (msg.type === 'console' && msg.args) {
              const args = ['[Web]', ...(msg.args || [])];
              if (msg.level === 'error') console.error(...args);
              else if (msg.level === 'warn') console.warn(...args);
              else console.log(...args);
            }
          }}
        />
        <vstack padding="medium" gap="medium">
          <button icon="refresh" onPress={() => setKey(k => k + 1)}>Reload Game</button>
          <text size="small" color="neutral-content-weak">Logs are piped to terminal</text>
        </vstack>
      </vstack>
    );
  },
});

Devvit.addMenuItem({
  label: 'Create ${safeTitle}',
  location: 'subreddit',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const post = await reddit.submitPost({
        title: '${safeTitle}',
        subredditName: subreddit.name,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle">
            <text size="large">Loading Game...</text>
          </vstack>
        ),
      });
      ui.showToast('Game created!');
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast('Failed to create game post');
    }
  },
});

export default Devvit;
`;
};

