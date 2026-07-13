/**
 * CHWYL 취향지도 Netlify Serverless API Bridge
 * GitHub Discussions GraphQL API를 프록시 중계하여 
 * 보안 토큰 노출 없이 안전하게 CRUD 기능을 수행합니다.
 */

// Node 18+ 글로벌 fetch 지원 환경 기준
exports.handler = async function (event, context) {
  // CORS 처리 및 기본 응답 헤더 설정
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  // 프리플라이트 요청 처리
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // 1. 필수 환경변수 검증
  const pat = process.env.GITHUB_PAT;
  const repoEnv = process.env.GITHUB_REPO_NAME;

  if (!pat || !repoEnv) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "서버 설정 에러: GITHUB_PAT 또는 GITHUB_REPO_NAME 환경변수가 Netlify에 세팅되지 않았습니다."
      })
    };
  }

  const [owner, name] = repoEnv.split('/');
  if (!owner || !name) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "서버 설정 에러: GITHUB_REPO_NAME은 '아이디/레포이름' 형식이어야 합니다."
      })
    };
  }

  // 2. 요청 파라미터 획득
  const method = event.httpMethod;
  const action = event.queryStringParameters.action || '';

  try {
    // === [기능 1] GET: 장소 리스트 불러오기 ===
    if (method === 'GET' && action === 'getPlaces') {
      // 1) Repository ID 및 "Places" 카테고리 ID 찾기
      const repoInfo = await fetchGitHub(
        `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            id
            discussionCategories(first: 20) {
              nodes {
                id
                name
              }
            }
          }
        }`,
        { owner, name }
      );

      const repoId = repoInfo.repository.id;
      const categories = repoInfo.repository.discussionCategories.nodes;
      const placesCategory = categories.find(c => c.name === 'Places');

      if (!placesCategory) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({
            error: "GitHub 저장소에 'Places' 카테고리가 존재하지 않습니다. Discussions에서 카테고리를 먼저 개설해 주세요."
          })
        };
      }

      // 2) Places 카테고리의 토론글 100개 불러오기
      const discussionsData = await fetchGitHub(
        `query($owner: String!, $name: String!, $categoryId: ID!) {
          repository(owner: $owner, name: $name) {
            discussions(first: 100, categoryId: $categoryId, orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes {
                id
                title
                body
                createdAt
              }
            }
          }
        }`,
        { owner, name, categoryId: placesCategory.id }
      );

      const discussions = discussionsData.repository.discussions.nodes;

      // 3) 마크다운 본문의 Frontmatter 파싱하여 JSON 변환
      const formattedPlaces = discussions.map(node => {
        const parsed = parseFrontmatter(node.body);
        const tags = parsed.metadata.tags || [];
        const tagMap = {
          work: "#조용한작업",
          date: "#힙한데이트",
          healing: "#아늑한쉼",
          night: "#감각적혼술"
        };
        const tagNames = tags.map(t => tagMap[t] || `#${t}`);

        return {
          id: node.id, // GitHub ID 직접 사용 (상세보기 매핑용)
          title: node.title,
          area: parsed.metadata.area || "서울시",
          oneLine: parsed.metadata.oneLine || "큐레이터가 엄선한 고유의 공간",
          review: parsed.content.trim(),
          tags: tags,
          tagNames: tagNames,
          rating: parsed.metadata.rating || "5.0",
          img: parsed.metadata.img || "https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?auto=format&fit=crop&w=800&q=80",
          address: parsed.metadata.address || "위치 정보 없음",
          createdAt: node.createdAt
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ places: formattedPlaces })
      };
    }

    // === [기능 2] POST: 새 장소 등록 (큐레이터 전용) ===
    if (method === 'POST' && action === 'createPlace') {
      const bodyParams = JSON.parse(event.body || '{}');
      const { title, area, oneLine, review, tags, rating, img, address } = bodyParams;

      if (!title || !area || !oneLine || !review || !tags || !rating || !address) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "필수 정보가 누락되었습니다." })
        };
      }

      // 1) Repository ID 및 Category ID 획득
      const repoInfo = await fetchGitHub(
        `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            id
            discussionCategories(first: 20) {
              nodes {
                id
                name
              }
            }
          }
        }`,
        { owner, name }
      );

      const repoId = repoInfo.repository.id;
      const categories = repoInfo.repository.discussionCategories.nodes;
      const placesCategory = categories.find(c => c.name === 'Places');

      if (!placesCategory) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "Places 카테고리를 찾을 수 없습니다." })
        };
      }

      // 2) 본문에 담을 마크다운 Frontmatter 구성
      const discussionBody = `---
area: "${area}"
oneLine: "${oneLine}"
tags: ${JSON.stringify(tags)}
rating: "${parseFloat(rating).toFixed(1)}"
img: "${img}"
address: "${address}"
---
${review}`;

      // 3) Discussion 생성 뮤테이션 실행
      const mutationResult = await fetchGitHub(
        `mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
          createDiscussion(input: {repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body}) {
            discussion {
              id
              title
            }
          }
        }`,
        {
          repositoryId: repoId,
          categoryId: placesCategory.id,
          title: title,
          body: discussionBody
        }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          discussion: mutationResult.createDiscussion.discussion
        })
      };
    }

    // === [기능 3] GET: 장소별 댓글 목록 가져오기 ===
    if (method === 'GET' && action === 'getComments') {
      const discussionId = event.queryStringParameters.discussionId;
      if (!discussionId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "discussionId가 누락되었습니다." }) };
      }

      const commentsData = await fetchGitHub(
        `query($discussionId: ID!) {
          node(id: $discussionId) {
            ... on Discussion {
              comments(first: 100) {
                nodes {
                  id
                  body
                  createdAt
                  author {
                    login
                  }
                }
              }
            }
          }
        }`,
        { discussionId }
      );

      const rawComments = commentsData.node.comments.nodes;

      // 댓글 파싱 [RATING:5.0] 형식 해석
      const parsedComments = rawComments.map(c => {
        const match = c.body.match(/^\[RATING:([\d.]+)\]\s*([\s\S]*)$/);
        return {
          id: c.id,
          author: c.author ? c.author.login : "익명 큐레이터",
          rating: match ? match[1] : null,
          text: match ? match[2].trim() : c.body,
          createdAt: c.createdAt
        };
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ comments: parsedComments })
      };
    }

    // === [기능 4] POST: 장소별 댓글 및 평점 남기기 ===
    if (method === 'POST' && action === 'createComment') {
      const bodyParams = JSON.parse(event.body || '{}');
      const { discussionId, rating, text } = bodyParams;

      if (!discussionId || !rating || !text) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "필수 인자가 누락되었습니다." }) };
      }

      // 평점 태그를 머리에 얹어서 댓글에 저장
      const formattedComment = `[RATING:${parseFloat(rating).toFixed(1)}] ${text}`;

      const mutationResult = await fetchGitHub(
        `mutation($discussionId: ID!, $body: String!) {
          addDiscussionComment(input: {discussionId: $discussionId, body: $body}) {
            comment {
              id
              body
            }
          }
        }`,
        { discussionId, body: formattedComment }
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          comment: mutationResult.addDiscussionComment.comment
        })
      };
    }

    // 일치하는 액션이 없는 경우
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "올바르지 않은 API 액션 요청입니다." })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || "서버 통신 중 원인 모를 예외가 발생했습니다." })
    };
  }
};

/**
 * GitHub GraphQL API 요청 전송 공용 헬퍼 함수
 */
async function fetchGitHub(query, variables = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${process.env.GITHUB_PAT}`,
      'Content-Type': 'application/json',
      'User-Agent': 'CHWYL-App-Client'
    },
    body: JSON.stringify({ query, variables })
  });

  const result = await response.json();
  if (result.errors) {
    throw new Error(`GitHub GraphQL API Error: ${result.errors.map(e => e.message).join(', ')}`);
  }
  return result.data;
}

/**
 * 마크다운 본문의 Frontmatter를 정규식으로 안전하게 파싱하는 헬퍼 함수
 */
function parseFrontmatter(body) {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { metadata: {}, content: body };

  const yamlBlock = match[1];
  const content = match[2];
  const metadata = {};

  yamlBlock.split('\n').forEach(line => {
    const parts = line.split(':');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      let value = parts.slice(1).join(':').trim();

      // 양 끝 따옴표 제거
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // JSON 배열 파싱 예: ["work", "healing"]
      if (value.startsWith('[') && value.endsWith(']')) {
        try {
          metadata[key] = JSON.parse(value.replace(/'/g, '"'));
        } catch (e) {
          metadata[key] = value;
        }
      } else {
        metadata[key] = value;
      }
    }
  });

  return { metadata, content };
}