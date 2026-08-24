package preset

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestLookupDigitalLesson(t *testing.T) {
	p, err := Lookup(DigitalLesson)
	if err != nil {
		t.Fatal(err)
	}
	if p.Copy.SubmitCTA == "" || p.Copy.CreateCTA == "" {
		t.Fatal("digital_lesson copy incomplete")
	}
	if len(p.Steps) == 0 || len(p.Artifacts) == 0 {
		t.Fatal("digital_lesson topology empty")
	}
}

func TestLookupUnknown(t *testing.T) {
	if _, err := Lookup("pr_campaign"); err == nil {
		t.Fatal("want error for unknown preset")
	}
}

func TestDigitalLessonCatalogConsistent(t *testing.T) {
	p, err := Lookup(DigitalLesson)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestEntitledNilMeansDigitalLesson(t *testing.T) {
	got := Entitled(nil)
	if len(got) != 1 || got[0] != DigitalLesson {
		t.Fatalf("got %v", got)
	}
}

func TestEntitledEmptyArrayMeansDigitalLesson(t *testing.T) {
	got := Entitled(json.RawMessage("[]"))
	if len(got) != 1 || got[0] != DigitalLesson {
		t.Fatalf("got %v", got)
	}
}

func TestEntitledListsIDs(t *testing.T) {
	got := Entitled(json.RawMessage(`["digital_lesson","pr_campaign"]`))
	if len(got) != 2 || got[0] != DigitalLesson || got[1] != "pr_campaign" {
		t.Fatalf("got %v", got)
	}
}

func TestResolveCreateSingleOmits(t *testing.T) {
	id, err := ResolveCreate("", []string{DigitalLesson})
	if err != nil || id != DigitalLesson {
		t.Fatalf("id=%s err=%v", id, err)
	}
}

func TestResolveCreateMultiUnspecified(t *testing.T) {
	_, err := ResolveCreate("", []string{DigitalLesson, "pr_campaign"})
	if !errors.Is(err, ErrUnspecified) {
		t.Fatalf("err=%v", err)
	}
}

func TestResolveCreateForbidden(t *testing.T) {
	_, err := ResolveCreate("pr_campaign", []string{DigitalLesson})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err=%v", err)
	}
}

func TestResolveCreateExplicitOK(t *testing.T) {
	id, err := ResolveCreate(DigitalLesson, []string{DigitalLesson, "pr_campaign"})
	if err != nil || id != DigitalLesson {
		t.Fatalf("id=%s err=%v", id, err)
	}
}
