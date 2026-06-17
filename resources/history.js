riot.tag(
  'hist',
  `
    <h3 class="title">History</h3>
    <div class="inputs">
      <label>Search History</label>
      <input type="text" name="search" onkeyup="{ filter }">
      <input type="button" name="clear" value="Clearing Browsing Data" onclick="{ clear }" style="float: right;">
    </div>
    <ul id="history">
      <hist-date-li each="{ day,i in getHistory() }" data="{ day }"></hist-date-li> 
    </ul>
  `,
  function (opts) {
    this.filter = (function (_this) {
      return function (e) {
        var term = (document.querySelector('[name=search]').value || '').toLowerCase();
        var groups = document.querySelectorAll('#history > hist-date-li');
        [].forEach.call(groups, function (group) {
          var items = group.querySelectorAll('.histories-wrapper > li');
          var anyVisible = false;
          [].forEach.call(items, function (item) {
            var link = item.querySelector('[data-link]');
            var uri = link ? (link.getAttribute('data-link') || '').toLowerCase() : '';
            var title = link ? link.textContent.trim().toLowerCase() : '';
            var show = term.length < 2 || uri.indexOf(term) >= 0 || title.indexOf(term) >= 0;
            item.style.display = show ? '' : 'none';
            if (show) anyVisible = true;
          });
          group.style.display = (term.length < 2 || anyVisible) ? '' : 'none';
        });
      };
    })(this);

    this.clear = (function (_this) {
      return function (e) {
        var history;
        history = $.jStorage.get('bp.history');
        history.length = 0;
        $.jStorage.set('bp.history', history);
        return _this.update();
      };
    })(this);

    this.getHistory = (function (_this) {
      return function () {
        var history;
        return (history = $.jStorage.get('bp.history'));
      };
    })(this);
  }
);

riot.tag(
  'hist-date-li',
  `
    <li class="{ hide: itms.hide_date }">
      <div class="history-group-title">
        <span>{ getDate(opts.data) }</span> 
        <img src="trash.svg" class="trash" onclick="{ deleteDate }"></img>
      </div>
      <ul class="histories-wrapper">
        <li each="{ getEachDay(opts.data) }" class="{ hide: hide }">
          <div class="history">
            <span>{ parent.showDate(date) }</span>
            <a href="#" title="#{ uri }" data-link-type="history" data-link="{uri}">
            <img class="favicon" riot-src="{ parent.getFavIcon(uri)}" alt="" title="#{ uri }"> { parent.getTitle(uri) } </a>
            <img class="trash" src="trash.svg" onclick="{ parent.delete }"></img>
          </div>
        </li>
      </ul>
    </li>
  `,
  'hist-date-li .hide { display: none; }',
  function (opts) {
    this.showDate = (function (_this) {
      return function (date) {
        return moment(date).format('h:mm A');
      };
    })(this);

    this.getTitle = (function (_this) {
      return function (uri) {
        var title;
        title = $.jStorage.get('bp.title');
        if (title[uri]) {
          return title[uri].slice(0, 51);
        } else {
          return uri.slice(0, 51);
        }
      };
    })(this);

    this.getFavIcon = (function (_this) {
      return function (uri) {
        var auri, aurl, favIcon, ico, icon, url;
        favIcon = $.jStorage.get('bp.favIcon');
        icon = favIcon[uri];
        if (!icon) {
          for (url in favIcon) {
            ico = favIcon[url];
            aurl = document.createElement('a');
            aurl.href = url;
            auri = document.createElement('a');
            auri.href = uri;
            if (auri.hostname === aurl.hostname) {
              icon = ico;
              return icon;
            }
          }
        }
        return icon;
      };
    })(this);

    this.getEachDay = (function (_this) {
      return function (obj) {
        var date, itms;
        for (date in obj) {
          itms = obj[date];
          _this.date = date;
          _this.itms = itms;
        }
        return _this.itms;
      };
    })(this);

    this.getDate = (function (_this) {
      return function (obj) {
        var date, datum, itms, today, weekAgo, yday;
        today = moment().startOf('day');
        yday = moment().subtract(1, 'days').startOf('day');
        weekAgo = moment().subtract(7, 'days').startOf('day');
        for (date in obj) {
          itms = obj[date];
          _this.date = date;
          _this.itms = itms;
        }
        datum = moment(date, 'YYYYMMDD').format('dddd, MMMM Do YYYY');
        if (moment(_this.date, 'YYYYMMDD').isSame(today)) {
          datum = 'Today ' + datum;
        }
        if (moment(_this.date, 'YYYYMMDD').isSame(yday)) {
          datum = 'Yesterday ' + datum;
        }
        if (moment(_this.date, 'YYYYMMDD').isSame(weekAgo)) {
          datum = 'A Week Ago ' + datum;
        }
        return datum;
      };
    })(this);

    this.deleteDate = (function (_this) {
      return function (e) {
        var date, hist, i, key, obj, _i, _len;
        hist = $.jStorage.get('bp.history');
        for (i = _i = 0, _len = hist.length; _i < _len; i = ++_i) {
          key = hist[i];
          for (date in key) {
            obj = key[date];
            if (date === _this.date) {
              hist.splice(i, 1);
            }
          }
        }
        $.jStorage.set('bp.history', hist);
        return _this.unmount();
      };
    })(this);

    this['delete'] = (function (_this) {
      return function (e) {
        var hist, history, idx, itm, thatDay, _i, _len;
        hist = $.jStorage.get('bp.history');
        itm = e.item;
        idx = _this.itms.indexOf(itm);
        history = $.jStorage.get('bp.history');
        for (_i = 0, _len = history.length; _i < _len; _i++) {
          hist = history[_i];
          if ((thatDay = hist[_this.date])) {
            thatDay.splice(idx, 1);
            break;
          }
        }
        $.jStorage.set('bp.history', history);
        if (thatDay.length === 0) {
          return _this.deleteDate();
        }
      };
    })(this);
  }
);
