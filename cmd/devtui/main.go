// Command devtui 是 CoDelphi 本地网关 TUI：只打本机 /v1/*（Bearer dev），
// 由 adapter 再打 PPTCreator。不要直连 PPTCreator /mcp。
//
// 拓扑（与 gzhanlei/PPTCreator#128 配对）：
//
//	PPTCreator: npm run dev + npm run worker
//	            PARTNER_API_KEYS=<key>  PARTNER_ALLOW_LOOPBACK_URL=1
//	CoDelphi:   HTTP_ADDR=:8080  CODELPHI_DEV_AUTH_SUB=dev-local
//	            PPTCREATOR_PARTNER_BASE_URL=http://127.0.0.1:3005
//	            PPTCREATOR_PARTNER_KEY=<same>
//	            PUBLIC_BASE_URL=http://127.0.0.1:8080
//	            sh scripts/dev-seed.sh
//
//	go run ./cmd/devtui -textbook 课文.md -title "第 3 章 导数" -until ready
package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codelphi/internal/devtui"
)

func main() {
	f, err := devtui.ParseFlags(os.Args[1:])
	if err != nil {
		log.Fatal(err)
	}
	if f.Help {
		fmt.Print(usage)
		return
	}
	c := &devtui.Client{
		HTTP: &http.Client{Timeout: 30 * time.Second},
		Cfg:  devtui.Config{Base: f.Base, Token: f.Token, OrgID: f.OrgID},
	}
	if f.Textbook != "" || f.RebuildKind != "" || f.Confirm || (f.Package != "" && f.Until != "") {
		if _, _, err := runOneShot(c, f); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := runMenu(c, f); err != nil {
		log.Fatal(err)
	}
}

const usage = `devtui — 本地网关 /v1 联调（Bearer dev）

  go run ./cmd/devtui -textbook 课文.md -title "第 3 章 导数" -until ready
  go run ./cmd/devtui -package <id> -rebuild-kind ppt -critique "封面改导数定义"
  go run ./cmd/devtui -lesson <job> -confirm

不直连 PPTCreator。材料签名 URL 依赖 PUBLIC_BASE_URL=http://127.0.0.1:8080，
且 PPTCreator 开 PARTNER_ALLOW_LOOPBACK_URL=1。
`

func runOneShot(c *devtui.Client, f devtui.Flags) (pkgID, lessonID string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	h, err := c.Health(ctx)
	if err != nil {
		return "", "", fmt.Errorf("healthz: %w", err)
	}
	fmt.Printf("healthz %v\n", h)
	if _, err := c.Me(ctx); err != nil {
		return "", "", fmt.Errorf("/v1/me: %w（检查 CODELPHI_DEV_AUTH_SUB 与 dev-seed）", err)
	}

	pkgID = f.Package
	lessonID = f.Lesson

	if f.Textbook != "" {
		data, err := os.ReadFile(f.Textbook)
		if err != nil {
			return "", "", err
		}
		kind, ok := devtui.KindFromFilename(f.Textbook)
		if !ok {
			return "", "", fmt.Errorf("不支持的材料类型：%s", f.Textbook)
		}
		pid, err := c.CreateProject(ctx, f.Title)
		if err != nil {
			return "", "", err
		}
		fmt.Println("project", pid)
		lid, err := c.CreateLesson(ctx, pid, f.Title)
		if err != nil {
			return "", "", err
		}
		fmt.Println("lesson", lid)
		if err := c.UploadMaterial(ctx, pid, lid, filepath.Base(f.Textbook), kind, data); err != nil {
			return "", "", err
		}
		ref, err := c.Submit(ctx, pid, lid, f.Note)
		if err != nil {
			return "", "", err
		}
		pkgID, lessonID = ref.PackageID, ref.LessonJobID
		fmt.Printf("submitted package=%s lesson_job=%s status=%s\n", pkgID, lessonID, ref.Status)
	}

	if f.RebuildKind != "" {
		if pkgID == "" {
			return "", "", fmt.Errorf("-rebuild-kind 需要 -package")
		}
		if err := c.Rebuild(ctx, pkgID, f.RebuildKind, f.Critique); err != nil {
			return "", "", err
		}
		fmt.Println("rebuild accepted")
	}

	if f.Confirm {
		if lessonID == "" {
			return "", "", fmt.Errorf("-confirm 需要 -lesson")
		}
		ref, err := c.Confirm(ctx, lessonID)
		if err != nil {
			return "", "", err
		}
		fmt.Printf("confirm %s %s\n", ref.Status, ref.PackageID)
		if pkgID == "" {
			pkgID = ref.PackageID
		}
	}

	if f.Until != "" && pkgID != "" {
		pkg, pollErr := devtui.PollPackage(ctx, c, pkgID, f.Until == "confirm", 4*time.Second)
		if pkg != nil {
			fmt.Print(devtui.FormatPackage(pkg))
		}
		if pollErr != nil {
			return pkgID, lessonID, pollErr
		}
	} else if pkgID != "" && f.RebuildKind == "" {
		pkg, err := c.GetPackage(ctx, pkgID)
		if err != nil {
			return pkgID, lessonID, err
		}
		fmt.Print(devtui.FormatPackage(pkg))
	} else if f.RebuildKind != "" {
		fmt.Println("rebuild 是异步的，加 -until ready 轮询")
	}
	return pkgID, lessonID, nil
}

func runMenu(c *devtui.Client, f devtui.Flags) error {
	in := bufio.NewScanner(os.Stdin)
	pkgID, lessonJobID := f.Package, f.Lesson
	ctx := context.Background()
	fmt.Print(usage)
	for {
		fmt.Print(`
1) healthz + /v1/me
2) 新建课程+课+上传+submit
3) 轮询 package
4) confirm
5) rebuild
q) 退出
> `)
		if !in.Scan() {
			return in.Err()
		}
		choice := strings.TrimSpace(in.Text())
		switch choice {
		case "q", "Q":
			return nil
		case "1":
			h, err := c.Health(ctx)
			if err != nil {
				fmt.Println(err)
				continue
			}
			fmt.Println(h)
			me, err := c.Me(ctx)
			if err != nil {
				fmt.Println(err)
				continue
			}
			fmt.Println(string(me))
		case "2":
			fmt.Print("课文路径: ")
			if !in.Scan() {
				return in.Err()
			}
			f.Textbook = strings.TrimSpace(in.Text())
			fmt.Print("标题: ")
			if !in.Scan() {
				return in.Err()
			}
			if t := strings.TrimSpace(in.Text()); t != "" {
				f.Title = t
			}
			f.Until = "ready"
			id, job, err := runOneShot(c, f)
			if err != nil {
				fmt.Println(err)
			}
			if id != "" {
				pkgID = id
			}
			if job != "" {
				lessonJobID = job
			}
		case "3":
			id := pkgID
			if id == "" {
				fmt.Print("package id: ")
				if !in.Scan() {
					return in.Err()
				}
				id = strings.TrimSpace(in.Text())
			}
			pollCtx, cancel := context.WithTimeout(ctx, 45*time.Minute)
			pkg, err := devtui.PollPackage(pollCtx, c, id, false, 4*time.Second)
			cancel()
			if pkg != nil {
				pkgID = pkg.ID
				if pkg.LessonJobID != "" {
					lessonJobID = pkg.LessonJobID
				}
				fmt.Print(devtui.FormatPackage(pkg))
			}
			if err != nil {
				fmt.Println(err)
			}
		case "4":
			id := lessonJobID
			if id == "" {
				fmt.Print("lesson job id: ")
				if !in.Scan() {
					return in.Err()
				}
				id = strings.TrimSpace(in.Text())
			}
			ref, err := c.Confirm(ctx, id)
			if err != nil {
				fmt.Println(err)
				continue
			}
			fmt.Printf("%+v\n", ref)
			if ref.PackageID != "" {
				pkgID = ref.PackageID
			}
		case "5":
			id := pkgID
			if id == "" {
				fmt.Print("package id: ")
				if !in.Scan() {
					return in.Err()
				}
				id = strings.TrimSpace(in.Text())
			}
			fmt.Print("kind (plan|ppt): ")
			if !in.Scan() {
				return in.Err()
			}
			kind := strings.TrimSpace(in.Text())
			fmt.Print("critique: ")
			if !in.Scan() {
				return in.Err()
			}
			if err := c.Rebuild(ctx, id, kind, strings.TrimSpace(in.Text())); err != nil {
				fmt.Println(err)
			}
		default:
			fmt.Println("未知选项")
		}
	}
}
